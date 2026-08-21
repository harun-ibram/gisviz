import json
import logging
import math
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
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
def _row_to_dict(obj: SQLModel, geojson: str | None, **extra: str | None) -> dict[str, Any]:
    """
    A row plus its geometry columns rendered as GeoJSON.

    `exclude` takes a *set*. It used to be passed the string "geom", which
    pydantic iterates as {'g','e','o','m'} — none of which are field names, so
    nothing was excluded and the raw EWKB hex survived, only to be overwritten
    on the next line. That was harmless while `geom` was the sole geometry
    column; any second one would have leaked hex straight to the client.

    `extra` maps a field name to its ST_AsGeoJSON string, so a caller can render
    several geometry columns in one pass.
    """
    data = obj.model_dump(exclude={"geom", *extra})
    data["geom"] = json.loads(geojson) if geojson else None
    for name, value in extra.items():
        data[name] = json.loads(value) if value else None
    return data


def _mesh_fields(mesh_path: str | None) -> dict[str, Any]:
    """
    The mesh half of a model_path response.

    Always present, always nullable. New jobs attach both artifacts at once, but
    a target reconstructed under the old splat->SuGaR pipeline may have a model
    and no mesh — so callers must still treat it as optional.
    """
    if not mesh_path:
        return {"mesh_path": None, "mesh_url": None, "mesh_filename": None}
    return {
        "mesh_path": mesh_path,
        "mesh_url": get_signed_url(mesh_path),
        "mesh_filename": mesh_path.split("/")[-1],
    }



@app.get("/splat-url")
async def get_splat_url(path: str = Query(...), download: bool = False):
    # `download=true` is what the viewer's download button asks for: the same
    # object, signed so R2 returns it as an attachment. The viewer's *loading*
    # path deliberately does not set it — that URL is fetched by JS, and a
    # Content-Disposition on it would do nothing but confuse the cache.
    filename = path.split("/")[-1]
    return {
        "url": get_signed_url(path, download_as=filename if download else None),
        "filename": filename,
    }

# API endpoints
# `geom` is rendered as GeoJSON and is now the only geometry column — it carries
# the pin or the area, whichever this node is. Left to model_dump it would come
# back as raw EWKB hex, hence the explicit ST_AsGeoJSON.
_NODE_SELECT = select(
    OSMNode,
    func.ST_AsGeoJSON(OSMNode.geom),
)


@app.get("/nodes")
async def get_nodes(session: SessionDep):
    rows = session.exec(_NODE_SELECT).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/splat_nodes")
async def get_splat_nodes(session: SessionDep):
    rows = session.exec(
        _NODE_SELECT.where(OSMNode.model_path != None)
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/nodes/{node_id}")
async def get_node(node_id: int, session: SessionDep):
    row = session.exec(
        _NODE_SELECT.where(OSMNode.node_id == node_id)
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
        # Nullable — see _mesh_fields. Set alongside model_path for anything
        # reconstructed by GS2Mesh, absent for older splat-only targets.
        **_mesh_fields(node.mesh_path),
    }
    
# ---------------------------------------------------------------------------
# Drawn outlines
#
# These endpoints are the first place the API accepts geometry from a client,
# so the ring is checked in Python before it reaches SQL: ST_GeomFromGeoJSON on
# malformed input raises inside Postgres and would surface as a 500, and an
# unbounded vertex list is a cheap way to make the server do a lot of work.
# ---------------------------------------------------------------------------

# Generous enough for a hand-drawn outline, small enough that no single request
# can hand PostGIS a pathological ring.
MAX_POLYGON_VERTICES = 1000

# ~5e9 m2, roughly Belgium. This is a sanity bound against antimeridian wrap and
# pasted garbage, not a judgement about how large an area may legitimately be.
MAX_POLYGON_AREA_M2 = 5e9

# Every ring goes through the same expression: ST_MakeValid repairs a
# self-intersecting "bow tie" into a collection, and CollectionExtract(...,3)
# pulls the polygons back out of whatever it produced. A ring that degenerates
# to a line survives neither filter, so `checked` comes back empty and the
# INSERT ... SELECT writes no row at all — which is the 400 path, with no extra
# round trip to ask whether the geometry was usable.
_POLYGON_CTE = """
    WITH input AS (
        SELECT ST_Multi(ST_CollectionExtract(
                   ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326)), 3)) AS poly
    ),
    checked AS (
        SELECT poly FROM input
        WHERE poly IS NOT NULL
          AND NOT ST_IsEmpty(poly)
          AND ST_Area(poly::geography) > 0
          AND ST_Area(poly::geography) < :max_area
    )
"""

_BAD_OUTLINE = (
    "That outline is not a usable area — check for crossed edges or repeated points."
)


def _ring_to_geojson(points: list[list[float]]) -> str:
    """
    Validate a [[lon, lat], ...] ring and render it as a GeoJSON Polygon.

    The ring is closed here rather than in the browser: a drawing UI has no
    reason to know that GeoJSON wants the first position repeated at the end.
    """
    if not points:
        raise HTTPException(status_code=400, detail="Draw an outline first.")
    if len(points) < 3:
        raise HTTPException(
            status_code=400,
            detail=f"An area needs at least 3 corners; got {len(points)}.",
        )
    if len(points) > MAX_POLYGON_VERTICES:
        raise HTTPException(
            status_code=400,
            detail=f"That outline has {len(points)} corners; the limit is {MAX_POLYGON_VERTICES}.",
        )

    ring: list[list[float]] = []
    for index, point in enumerate(points):
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise HTTPException(
                status_code=400, detail=f"Corner {index + 1} is not a [lon, lat] pair."
            )
        lon, lat = float(point[0]), float(point[1])
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise HTTPException(
                status_code=400, detail=f"Corner {index + 1} is not a finite coordinate."
            )
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            raise HTTPException(
                status_code=400,
                detail=f"Corner {index + 1} ({lat:.5f}, {lon:.5f}) is off the map.",
            )
        ring.append([lon, lat])

    if ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    if len(ring) < 4:
        raise HTTPException(status_code=400, detail=_BAD_OUTLINE)

    return json.dumps({"type": "Polygon", "coordinates": [ring]})


class CreateNodeRequest(BaseModel):
    name: str
    # A drawn outline, [[lon, lat], ...]. `lat`/`lon` stay accepted so a client
    # that predates polygons keeps working; exactly one of the two is required.
    polygon: list[list[float]] | None = None
    lat: float | None = None
    lon: float | None = None


def _measure_drawn_later(background: BackgroundTasks, polygon: list[list[float]]) -> None:
    """
    Measure a freshly drawn outline against LiDAR already in the library.

    Backgrounded, unlike the /gis/measure-drawn backfill: somebody drawing an
    outline should not wait on an R2 download and a raster pass to find out
    their node was created. Best effort — a failure here leaves the target
    intact and unmeasured, which is the same state it had a second earlier.
    """
    lons = [point[0] for point in polygon]
    lats = [point[1] for point in polygon]
    bounds = [min(lons), min(lats), max(lons), max(lats)]

    def run() -> None:
        try:
            # Imported inside the task so a broken native GIS stack cannot stop
            # nodes from being created.
            from gis_worker import measure_drawn_targets

            measure_drawn_targets(bounds)
        except Exception:
            logger.warning("drawn measurement failed for %s", bounds, exc_info=True)

    background.add_task(run)


@app.post("/nodes", dependencies=[RequireUser])
async def create_node(
    body: CreateNodeRequest, session: SessionDep, background: BackgroundTasks
):
    """Create a node to attach a splat to later, from a drawn outline or a point."""
    tags = json.dumps({"name": body.name})

    if body.polygon is not None:
        # The outline *is* the node's geometry now — there is no longer a
        # separate footprint column, and no derived ST_PointOnSurface pin to
        # keep in sync with it. `source = 'drawn'` is what later tells a
        # hand-drawn area apart from an imported administrative boundary.
        sql = text(
            _POLYGON_CTE
            + """
            INSERT INTO osm.nodes (node_id, geom, tags, source)
            SELECT (SELECT COALESCE(MIN(node_id), 0) - 1 FROM osm.nodes),
                   c.poly,
                   CAST(:tags AS jsonb),
                   'drawn'
            FROM checked c
            RETURNING node_id
            """
        )
        params = {
            "geom": _ring_to_geojson(body.polygon),
            "max_area": MAX_POLYGON_AREA_M2,
            "tags": tags,
        }
    elif body.lat is not None and body.lon is not None:
        sql = text(
            """
            INSERT INTO osm.nodes (node_id, geom, tags, source)
            VALUES (
                (SELECT COALESCE(MIN(node_id), 0) - 1 FROM osm.nodes),
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
                CAST(:tags AS jsonb),
                'drawn'
            )
            RETURNING node_id
            """
        )
        params = {"lon": body.lon, "lat": body.lat, "tags": tags}
    else:
        raise HTTPException(
            status_code=400, detail="Provide either a drawn outline or a lat/lon pair."
        )

    node_id = _insert_with_id_retry(session, sql, params)
    if node_id is None:
        raise HTTPException(status_code=400, detail=_BAD_OUTLINE)
    if body.polygon is not None:
        _measure_drawn_later(background, body.polygon)
    return {"node_id": node_id}


def _insert_with_id_retry(session, sql, params, attempts: int = 3):
    """
    Run an insert that allocates its own id, retrying on a duplicate key.

    Node ids come from `MIN(node_id) - 1`, which two concurrent creates can read
    as the same value. Drawing an outline makes the create interaction long
    enough that overlapping requests stop being hypothetical.

    Returns the RETURNING value, or None when the statement matched no rows —
    which for the polygon path means the outline did not survive validation.
    """
    for attempt in range(attempts):
        try:
            row = session.exec(sql, params=params).first()
            session.commit()
            return row[0] if row else None
        except IntegrityError as exc:
            session.rollback()
            if attempt == attempts - 1:
                raise HTTPException(
                    status_code=409,
                    detail="Another target was created at the same moment. Try again.",
                ) from exc
    return None


# The /regions endpoints are gone. A region was a node with an area, so every
# one of them had a /nodes twin that now serves both shapes:
#
#   POST /regions            -> POST /nodes with a `polygon` body
#   GET  /regions            -> GET  /nodes
#   GET  /splat_regions      -> GET  /splat_nodes
#   GET  /regions/{id}       -> GET  /nodes/{node_id}
#   GET  /regions/{id}/model_path -> GET /nodes/{node_id}/model_path
#
# The one behaviour with no equivalent is POST /regions with no polygon, which
# created a named region with a NULL boundary. osm.nodes.geom is NOT NULL, and
# the frontend already refused that path (Upload.jsx: "Both types now need a
# geometry"), so nothing is left to migrate.


# ---------------------------------------------------------------------------
# Splat ingestion: photos -> GS2Mesh (on Modal) -> a splat and a mesh in R2.
#
# Driven by the single-worker `gisviz-gs2mesh` app (gpu/gs2mesh_app.py), which
# replaced the two-stage gisviz-splat -> gisviz-sugar pipeline. Those two apps
# are still deployed and their sources are untouched under gpu/, but nothing
# here spawns them any more.
#
# The shape of the change: one Modal call now yields *both* artifacts, so the
# splat->mesh handoff this module used to orchestrate is gone. No bundle is
# staged between stages, there is no window where the splat is servable and the
# mesh is not, and one webhook reports both.
# ---------------------------------------------------------------------------

class CreateJobRequest(BaseModel):
    node_id: int              # osm.nodes.node_id, point or area alike
    filenames: list[str]      # photo filenames the client will upload
    # Accepted for backwards compatibility, but no longer gates any work: the
    # mesh is what GS2Mesh's pipeline is *for* — the splat is an intermediate on
    # the way to it — so there is no cheaper splat-only path to opt out into.
    # Every job now produces both, and the mesh is attached either way.
    want_mesh: bool = True


class WebhookRequest(BaseModel):
    status: str               # "done" | "failed"
    output_key: str | None = None   # R2 key of the 3DGS .ply
    mesh_key: str | None = None     # R2 key of the .glb
    error: str | None = None
    # Reported for the logs only. The old pipeline had no equivalent — SuGaR
    # never told us how large the splat it consumed was.
    backend: str | None = None
    gaussians: int | None = None
    mesh_bytes: int | None = None


@app.post("/jobs", dependencies=[RequireUser])
async def create_job(body: CreateJobRequest, session: SessionDep):
    """Create a job and hand back presigned PUT URLs to upload the photos to R2."""
    if not body.filenames:
        raise HTTPException(status_code=400, detail="filenames must not be empty")

    job_id = str(uuid.uuid4())
    input_prefix = f"inputs/{job_id}/"

    job = Job(
        id=job_id,
        status="pending",
        node_id=body.node_id,
        input_prefix=input_prefix,
        want_mesh=body.want_mesh,
    )
    session.add(job)
    session.commit()

    upload_urls = {
        name: get_upload_url(f"{input_prefix}{name}") for name in body.filenames
    }
    return {"job_id": job_id, "input_prefix": input_prefix, "upload_urls": upload_urls}


def _job_target(job: Job, session: Session) -> OSMNode | None:
    """The node a job's artifacts get attached to."""
    return session.get(OSMNode, job.node_id)


def _target_name(job: Job, session: Session) -> str | None:
    """The display name of a job's node, used to name the output splat."""
    target = _job_target(job, session)
    return target.name if target else None


def _spawn_gs2mesh_job(job: Job, session: Session) -> None:
    """
    Spawn the one Modal call that produces both artifacts.

    Sets output_key/mesh_key and both status fields; the caller commits. Shared
    by /jobs/{id}/start and the /jobs/{id}/mesh re-run, which under a
    single-stage pipeline are the same operation.
    """
    import modal  # lazy import: keep the API importable even if modal is absent

    # Name the objects after the target so downloads and the viewer's filename
    # (model_path.split("/")[-1]) read as "old_town.ply" rather than "scene.ply"
    # for every splat ever produced. The job_id stays in the prefix, so it is
    # still what guarantees uniqueness — two targets may share a name, and
    # re-running a job must not overwrite the previous splat. The mesh is the
    # same directory and slug with a different extension: "next to the gaussian
    # model" is meant literally, so anything holding model_path can derive the
    # mesh key without another round trip.
    output_key = job.output_key or (
        f"models/{job.id}/{slugify(_target_name(job, session) or 'scene')}.ply"
    )
    mesh_key = f"{output_key.rsplit('.', 1)[0]}.glb"
    backend_url = os.environ["BACKEND_PUBLIC_URL"].rstrip("/")
    webhook_url = f"{backend_url}/jobs/{job.id}/webhook"

    process = modal.Function.from_name("gisviz-gs2mesh", "process")
    call = process.spawn(job.id, job.input_prefix, output_key, mesh_key, webhook_url)

    job.output_key = output_key
    job.mesh_key = mesh_key
    job.modal_call_id = getattr(call, "object_id", None)
    job.mesh_call_id = job.modal_call_id  # one call produces both artifacts
    job.status = "processing"
    job.error = None
    # Both artifacts now arrive together, so the mesh is in flight from the same
    # moment the splat is — never 'skipped', which only existed because the old
    # pipeline could reach the mesh stage with nothing staged to mesh from.
    job.mesh_status = "processing"
    job.mesh_error = None


@app.post("/jobs/{job_id}/start", dependencies=[RequireUser])
async def start_job(job_id: str, session: SessionDep):
    """Kick off the GPU job on Modal once the photos have been uploaded."""
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "processing":
        return {"job_id": job_id, "status": job.status}

    _spawn_gs2mesh_job(job, session)
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
        # A client polling this for "is the model ready?" still behaves
        # correctly, but the answer now arrives at the same time as the mesh's
        # rather than roughly half an hour earlier: GS2Mesh produces both in one
        # pass, so there is no longer a window where one is servable and the
        # other is not.
        "status": job.status,
        "node_id": job.node_id,
        "output_key": job.output_key,
        "error": job.error,
        # Vestigial: every job produces a mesh now. Kept in the response so
        # existing clients do not see a field disappear.
        "want_mesh": job.want_mesh,
        # Tracks `status` exactly, since one run yields both. 'skipped' is no
        # longer reachable for new jobs.
        "mesh_status": job.mesh_status,
        "mesh_key": job.mesh_key,
        "mesh_error": job.mesh_error,
    }


def _purge_inputs(job: Job) -> None:
    """
    Drop the uploaded photos.

    Called once nothing that still has to run needs them. r2_delete_prefix is
    best-effort by design — orphaned objects cost pennies, while raising here
    would lose the result the caller recorded a line above.
    """
    deleted = r2_delete_prefix(job.input_prefix)
    # GS2Mesh stages no handoff bundle — it needs no second stage to hand off
    # to. Still cleaned up here so jobs created under the old two-stage pipeline
    # do not leave their bundles behind forever.
    if job.work_prefix:
        deleted += r2_delete_prefix(job.work_prefix)
    job.inputs_deleted_at = datetime.now(timezone.utc)
    logger.info("Job %s: purged %d source object(s)", job.id, deleted)


def _handle_result(job: Job, body: WebhookRequest, session: Session) -> None:
    """
    Record both artifacts from a finished GS2Mesh run.

    One worker, one webhook, both artifacts — so unlike the two-stage pipeline
    there is no partial-success path to reconcile here. Either the run produced
    a splat and a mesh or it produced neither.
    """
    if body.status != "done":
        job.status = "failed"
        job.error = body.error
        job.mesh_status = "failed"
        job.mesh_error = body.error
        # Deliberately no purge: the photos are the only thing a re-run needs,
        # and POST /jobs/{id}/mesh exists to re-run without asking for them
        # again.
        return

    target = _job_target(job, session)
    if not target:
        raise HTTPException(status_code=404, detail="Target feature not found")

    output_key = body.output_key or job.output_key
    mesh_key = body.mesh_key or job.mesh_key
    target.model_path = output_key
    target.mesh_path = mesh_key
    session.add(target)

    job.output_key = output_key
    job.status = "done"
    job.mesh_key = mesh_key
    job.mesh_status = "done"
    logger.info(
        "Job %s: %s gaussians, %s byte mesh via %s",
        job.id, body.gaussians, body.mesh_bytes, body.backend or "gs2mesh",
    )

    # Nothing else will read the photos.
    _purge_inputs(job)


@app.post("/jobs/{job_id}/webhook")
async def job_webhook(
    job_id: str,
    body: WebhookRequest,
    session: SessionDep,
    x_webhook_secret: Annotated[str | None, Header()] = None,
):
    """
    Called by gpu/gs2mesh_app.py on completion. Secret-verified before trust.
    """
    if x_webhook_secret != os.environ["JOB_WEBHOOK_SECRET"]:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    _handle_result(job, body, session)

    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "status": job.status, "mesh_status": job.mesh_status}


@app.post("/jobs/{job_id}/mesh", dependencies=[RequireUser])
async def retry_mesh_job(job_id: str, session: SessionDep):
    """
    Re-run a failed job.

    Kept at this path, and still keyed off mesh_status, because that is the
    contract the frontend already calls. What it does underneath has changed: a
    mesh can no longer fail independently of its splat, so "retry the mesh" is
    now "re-run the whole pipeline" — which is affordable precisely because a
    failure leaves the photos in place.
    """
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.mesh_status == "processing":
        return {"job_id": job_id, "mesh_status": job.mesh_status}
    # The photos are purged on success, so a finished job cannot be re-run
    # without a fresh upload. This also covers jobs from the old pipeline whose
    # photos went when their splat landed.
    if job.inputs_deleted_at:
        raise HTTPException(
            status_code=409,
            detail="This job's photos were already purged; re-running means re-uploading them.",
        )

    _spawn_gs2mesh_job(job, session)
    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "mesh_status": job.mesh_status}
