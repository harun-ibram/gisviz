import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, select

from auth import RequireUser, ensure_auth_schema
from auth_api import router as auth_router
from deps import SessionDep, engine, get_signed_url, get_upload_url, r2_client  # noqa: F401
from gis_api import router as gis_router
from gis_runtime import r2_delete_prefix, slugify
from gis_schema import ensure_gis_schema, reap_orphaned_gis_jobs
from models import (
    Job,
    OSMNode,
    OSMRelation,
    OSMRelationMember,
    OSMWay,
    OSMWayNode,
    Region,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Bring the GIS and auth schemas up to date and clear jobs a restart abandoned.

    Every step is best-effort: a DDL problem must never take the whole API
    down with it, and the public read-only surface works fine without them.
    """
    if os.environ.get("GIS_AUTO_MIGRATE", "1") != "0":
        try:
            ensure_gis_schema(engine)
        except Exception:
            logger.warning("GIS schema bootstrap failed; /gis may not work", exc_info=True)

        # Same flag rather than a second knob: both are "let the app create its
        # own tables on boot", and nobody wants to remember two of them.
        try:
            ensure_auth_schema(engine)
        except Exception:
            logger.warning("Auth schema bootstrap failed; logins may not work", exc_info=True)

    try:
        # Railway kills in-flight BackgroundTasks on redeploy, so anything left
        # queued or running belongs to a process that no longer exists.
        reap_orphaned_gis_jobs(engine)
    except Exception:
        logger.warning("Could not reap orphaned GIS jobs", exc_info=True)

    yield


# FastAPI and middleware
app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "https://gisviz.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(auth_router)
app.include_router(gis_router)


# Helper function for formatting the data in the table into a usable object
def _row_to_dict(obj: SQLModel, geojson: str | None) -> dict[str, Any]:
    data = obj.model_dump(exclude="geom")
    data["geom"] = json.loads(geojson) if geojson else None
    return data


def _mesh_fields(mesh_path: str | None) -> dict[str, Any]:
    """
    The SuGaR mesh half of a model_path response.

    Always present, always nullable: meshing runs after the splat is already
    served, so a target that has a model does not necessarily have a mesh yet.
    """
    if not mesh_path:
        return {"mesh_path": None, "mesh_url": None, "mesh_filename": None}
    return {
        "mesh_path": mesh_path,
        "mesh_url": get_signed_url(mesh_path),
        "mesh_filename": mesh_path.split("/")[-1],
    }



@app.get("/splat-url")
async def get_splat_url(path: str = Query(...)):
    return {"url": get_signed_url(path), "filename": path.split("/")[-1]}

# API endpoints
@app.get("/nodes")
async def get_nodes(session: SessionDep):
    rows = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/splat_nodes")
async def get_splat_nodes(session: SessionDep):
    rows = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
        .where(OSMNode.model_path != None)
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/nodes/{node_id}")
async def get_node(node_id: int, session: SessionDep):
    row = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
        .where(OSMNode.node_id == node_id)
    ).first()

    if not row:
        return {"error": "Node not found"}
    
    obj, geojson = row

    return _row_to_dict(obj, geojson)

@app.get("/nodes/{node_id}/model_path")
async def get_node_model_path(node_id: int, session: SessionDep):
    node = session.exec(
        select(OSMNode)
        .where(OSMNode.node_id == node_id)
    ).first()

    if not node or not node.model_path:
        return {"error": "Node not found"}

    return {
        "model_path": node.model_path,
        "url": get_signed_url(node.model_path),
        "filename": node.model_path.split("/")[-1],
        # Null until SuGaR has run over the splat, which happens well after the
        # model itself is servable — callers must treat it as optional.
        **_mesh_fields(node.mesh_path),
    }
    
class CreateNodeRequest(BaseModel):
    name: str
    lat: float
    lon: float


@app.post("/nodes", dependencies=[RequireUser])
async def create_node(body: CreateNodeRequest, session: SessionDep):
    """Create a bare node (point + name tag) to attach a splat to later."""
    row = session.exec(
        text(
            """
            INSERT INTO osm.nodes (node_id, geom, tags)
            VALUES (
                (SELECT COALESCE(MIN(node_id), 0) - 1 FROM osm.nodes),
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
                CAST(:tags AS jsonb)
            )
            RETURNING node_id
            """
        ),
        params={"lon": body.lon, "lat": body.lat, "tags": json.dumps({"name": body.name})},
    ).first()
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Could not create node: {exc.orig}") from exc
    return {"node_id": row[0]}


class CreateRegionRequest(BaseModel):
    name: str


@app.post("/regions", dependencies=[RequireUser])
async def create_region(body: CreateRegionRequest, session: SessionDep):
    """Create a bare region (name only, no boundary yet) to attach a splat to later."""
    region = Region(id=str(uuid.uuid4()), name=body.name, geom=None)
    session.add(region)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=400, detail=f"Could not create region: {exc.orig}") from exc
    return {"id": region.id, "name": region.name}


@app.get("/regions")
async def get_regions(session: SessionDep):
    rows = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/splat_regions")
async def get_splat_regions(session: SessionDep):
    rows = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
        .where(Region.model_path != None)
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/regions/{id}")
async def get_region(id: int, session: SessionDep):
    row = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
        .where(Region.id == id)
    ).first()

    if not row:
        return {"error": "Region not found"}
    
    obj, geojson = row
    
    return _row_to_dict(obj, geojson)

@app.get("/regions/{id}/model_path")
async def get_region_model_path(id: int, session: SessionDep):
    region = session.exec(
        select(Region)
        .where(Region.id == id)
    ).first()

    if not region:
        return {"error": "Region not found"}
    return {"model_path": region.model_path,
            "url": get_signed_url(region.model_path),
            "filename": region.model_path.split("/")[-1],
            **_mesh_fields(region.mesh_path),
    }


# ---------------------------------------------------------------------------
# Splat ingestion: photos -> COLMAP + Gaussian splatting (on Modal) -> R2.
# See gpu/splat_app.py for the GPU worker and Plan.md for the full flow.
# ---------------------------------------------------------------------------

class CreateJobRequest(BaseModel):
    target_type: str          # "node" | "region"
    target_id: str            # OSMNode.node_id (as str) or Region.id
    filenames: list[str]      # photo filenames the client will upload


class WebhookRequest(BaseModel):
    # Which worker is reporting. Defaults to the splat stage so a worker
    # deployed before this field existed still lands in the right branch.
    stage: str = "splat"      # "splat" | "mesh"
    status: str               # "done" | "failed"
    output_key: str | None = None
    error: str | None = None
    # splat stage: where the SuGaR handoff bundle was staged. Absent when
    # staging failed, which is what makes the mesh stage skippable.
    work_prefix: str | None = None
    mesh_key: str | None = None   # mesh stage: R2 key of the produced .glb


@app.post("/jobs", dependencies=[RequireUser])
async def create_job(body: CreateJobRequest, session: SessionDep):
    """Create a job and hand back presigned PUT URLs to upload the photos to R2."""
    if body.target_type not in ("node", "region"):
        raise HTTPException(status_code=400, detail="target_type must be 'node' or 'region'")
    if not body.filenames:
        raise HTTPException(status_code=400, detail="filenames must not be empty")

    job_id = str(uuid.uuid4())
    input_prefix = f"inputs/{job_id}/"

    job = Job(
        id=job_id,
        status="pending",
        target_type=body.target_type,
        target_id=body.target_id,
        input_prefix=input_prefix,
    )
    session.add(job)
    session.commit()

    upload_urls = {
        name: get_upload_url(f"{input_prefix}{name}") for name in body.filenames
    }
    return {"job_id": job_id, "input_prefix": input_prefix, "upload_urls": upload_urls}


def _job_target(job: Job, session: Session) -> OSMNode | Region | None:
    """The node or region a job's artifacts get attached to."""
    if job.target_type == "node":
        return session.get(OSMNode, int(job.target_id))
    return session.get(Region, job.target_id)


def _target_name(job: Job, session: Session) -> str | None:
    """The display name of a job's node/region, used to name the output splat."""
    target = _job_target(job, session)
    if not target:
        return None
    if job.target_type == "node":
        return (target.tags or {}).get("name")
    return target.name


@app.post("/jobs/{job_id}/start", dependencies=[RequireUser])
async def start_job(job_id: str, session: SessionDep):
    """Kick off the GPU job on Modal once the photos have been uploaded."""
    import modal  # lazy import: keep the API importable even if modal is absent

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "processing":
        return {"job_id": job_id, "status": job.status}

    # Name the object after the target so downloads and the viewer's filename
    # (model_path.split("/")[-1]) read as "old_town.ply" rather than "scene.ply"
    # for every splat ever produced. The job_id stays in the prefix, so it is
    # still what guarantees uniqueness — two targets may share a name, and
    # re-running a job must not overwrite the previous splat.
    output_key = f"models/{job_id}/{slugify(_target_name(job, session) or 'scene')}.ply"
    backend_url = os.environ["BACKEND_PUBLIC_URL"].rstrip("/")
    webhook_url = f"{backend_url}/jobs/{job_id}/webhook"

    process = modal.Function.from_name("gisviz-splat", "process")
    call = process.spawn(job_id, job.input_prefix, output_key, webhook_url)

    job.output_key = output_key
    job.modal_call_id = getattr(call, "object_id", None)
    job.status = "processing"
    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job_id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, session: SessionDep):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job.id,
        # Still the splat's status alone — clients poll this for "is the model
        # ready?" and meshing must not delay that answer.
        "status": job.status,
        "target_type": job.target_type,
        "target_id": job.target_id,
        "output_key": job.output_key,
        "error": job.error,
        "mesh_status": job.mesh_status,
        "mesh_key": job.mesh_key,
        "mesh_error": job.mesh_error,
    }


def _spawn_mesh_job(job: Job) -> None:
    """Run SuGaR over the splat this job just produced."""
    import modal  # lazy import, for the same reason as start_job

    backend_url = os.environ["BACKEND_PUBLIC_URL"].rstrip("/")
    webhook_url = f"{backend_url}/jobs/{job.id}/webhook"
    # Same directory and slug as the splat, different extension. "Next to the
    # gaussian model" is meant literally: anything holding model_path can derive
    # the mesh key without another round trip.
    mesh_key = f"{job.output_key.rsplit('.', 1)[0]}.glb"

    mesh = modal.Function.from_name("gisviz-sugar", "mesh")
    call = mesh.spawn(job.id, job.output_key, job.work_prefix, mesh_key, webhook_url)

    job.mesh_key = mesh_key
    job.mesh_call_id = getattr(call, "object_id", None)
    job.mesh_status = "processing"
    job.mesh_error = None


def _handle_splat_result(job: Job, body: WebhookRequest, session: Session) -> None:
    """Record the finished splat, then hand off to the mesh stage."""
    if body.status != "done":
        job.status = "failed"
        job.error = body.error
        return

    output_key = body.output_key or job.output_key
    target = _job_target(job, session)
    if not target:
        raise HTTPException(status_code=404, detail="Target feature not found")
    target.model_path = output_key
    session.add(target)
    job.output_key = output_key
    job.status = "done"

    # Everything below is the bonus stage. The splat is stored and the job is
    # already 'done', so nothing here may raise: the worst outcome allowed is a
    # model without a mesh.
    job.work_prefix = body.work_prefix
    if not body.work_prefix:
        job.mesh_status = "skipped"
        job.mesh_error = "The worker staged no inputs for meshing."
        return

    try:
        _spawn_mesh_job(job)
    except Exception:
        logger.warning("Could not spawn the mesh job for %s", job.id, exc_info=True)
        job.mesh_status = "failed"
        job.mesh_error = "Could not start the mesh job."


def _handle_mesh_result(job: Job, body: WebhookRequest, session: Session) -> None:
    """Record the finished mesh and, on success, purge the photos it consumed."""
    if body.status != "done":
        # Keep the photos. A failed mesh is the one case where retrying is still
        # possible without asking for the whole upload again.
        job.mesh_status = "failed"
        job.mesh_error = body.error
        return

    mesh_key = body.mesh_key or job.mesh_key
    target = _job_target(job, session)
    if not target:
        raise HTTPException(status_code=404, detail="Target feature not found")
    target.mesh_path = mesh_key
    session.add(target)
    job.mesh_key = mesh_key
    job.mesh_status = "done"

    # Both stages that need the photos have now run. r2_delete_prefix is
    # best-effort by design — orphaned objects cost pennies, while raising here
    # would lose the mesh result recorded a line above.
    deleted = r2_delete_prefix(job.input_prefix)
    if job.work_prefix:
        deleted += r2_delete_prefix(job.work_prefix)
    job.inputs_deleted_at = datetime.now(timezone.utc)
    logger.info("Job %s: purged %d source object(s) after meshing", job.id, deleted)


@app.post("/jobs/{job_id}/webhook")
async def job_webhook(
    job_id: str,
    body: WebhookRequest,
    session: SessionDep,
    x_webhook_secret: Annotated[str | None, Header()] = None,
):
    """
    Called by the Modal workers on completion. Secret-verified before trust.

    Both stages report here — the splat worker (gpu/splat_app.py) and the mesh
    worker (gpu/sugar_app.py) — distinguished by ``stage``.
    """
    if x_webhook_secret != os.environ["JOB_WEBHOOK_SECRET"]:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if body.stage == "mesh":
        _handle_mesh_result(job, body, session)
    else:
        _handle_splat_result(job, body, session)

    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "status": job.status, "mesh_status": job.mesh_status}


@app.post("/jobs/{job_id}/mesh", dependencies=[RequireUser])
async def retry_mesh_job(job_id: str, session: SessionDep):
    """Re-run SuGaR for a job whose mesh stage failed."""
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.mesh_status == "processing":
        return {"job_id": job_id, "mesh_status": job.mesh_status}
    if not job.output_key or not job.work_prefix:
        raise HTTPException(
            status_code=409, detail="This job has no staged splat to build a mesh from"
        )
    # The handoff bundle is purged along with the photos once a mesh succeeds,
    # so there is nothing left to re-run against.
    if job.inputs_deleted_at:
        raise HTTPException(
            status_code=409, detail="This job's inputs were already purged"
        )

    _spawn_mesh_job(job)
    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "mesh_status": job.mesh_status}
