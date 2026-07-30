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
from sqlmodel import SQLModel, select

from deps import SessionDep, engine, get_signed_url, get_upload_url, r2_client  # noqa: F401
from gis_api import router as gis_router
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
    Bring the GIS schema up to date and clear jobs a restart abandoned.

    Both steps are best-effort: a DDL problem must never take the whole API
    down with it, and everything outside /gis works fine without them.
    """
    if os.environ.get("GIS_AUTO_MIGRATE", "1") != "0":
        try:
            ensure_gis_schema(engine)
        except Exception:
            logger.warning("GIS schema bootstrap failed; /gis may not work", exc_info=True)

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

app.include_router(gis_router)


# Helper function for formatting the data in the table into a usable object
def _row_to_dict(obj: SQLModel, geojson: str | None) -> dict[str, Any]:
    data = obj.model_dump(exclude="geom")
    data["geom"] = json.loads(geojson) if geojson else None
    return data



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
    }
    
class CreateNodeRequest(BaseModel):
    name: str
    lat: float
    lon: float


@app.post("/nodes")
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


@app.post("/regions")
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
            "filename": region.model_path.split("/")[-1]
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
    status: str               # "done" | "failed"
    output_key: str | None = None
    error: str | None = None


@app.post("/jobs")
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


@app.post("/jobs/{job_id}/start")
async def start_job(job_id: str, session: SessionDep):
    """Kick off the GPU job on Modal once the photos have been uploaded."""
    import modal  # lazy import: keep the API importable even if modal is absent

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "processing":
        return {"job_id": job_id, "status": job.status}

    output_key = f"models/{job_id}/scene.ply"
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
        "status": job.status,
        "target_type": job.target_type,
        "target_id": job.target_id,
        "output_key": job.output_key,
        "error": job.error,
    }


@app.post("/jobs/{job_id}/webhook")
async def job_webhook(
    job_id: str,
    body: WebhookRequest,
    session: SessionDep,
    x_webhook_secret: Annotated[str | None, Header()] = None,
):
    """Called by the Modal worker on completion. Secret-verified before trust."""
    if x_webhook_secret != os.environ["JOB_WEBHOOK_SECRET"]:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if body.status == "done":
        output_key = body.output_key or job.output_key
        if job.target_type == "node":
            target = session.get(OSMNode, int(job.target_id))
        else:
            target = session.get(Region, job.target_id)
        if not target:
            raise HTTPException(status_code=404, detail="Target feature not found")
        target.model_path = output_key
        session.add(target)
        job.output_key = output_key
        job.status = "done"
    else:
        job.status = "failed"
        job.error = body.error

    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "status": job.status}
