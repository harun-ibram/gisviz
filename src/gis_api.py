"""
The /gis HTTP surface: upload -> process -> serve as map layers.

Mirrors the splat flow's shape (POST /jobs -> presigned PUT -> /start -> poll),
because the frontend already knows that shape. Everything here imports from
deps, never from main, so main can include this router without a cycle.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text

from auth import RequireUser
from deps import SessionDep, get_signed_url, get_upload_url
from gis_runtime import (
    ACCEPTED_EXTENSIONS,
    CONFIG,
    DEFAULT_OPTIONS,
    LAYER_TYPES,
    MAX_FILES,
    match_extension,
    r2_delete_keys,
    r2_delete_prefix,
    r2_head,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gis", tags=["gis"])


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
# Every mutating /gis route requires a logged-in user; the GETs stay public so
# the map keeps working for anonymous visitors. This replaces the old optional
# X-API-Key check, which nothing in the repo ever sent and which was a no-op
# whenever GIS_API_KEY was unset (i.e. by default).
Protected = RequireUser


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class GisFileSpec(BaseModel):
    filename: str
    size_bytes: int = 0


class GisOptions(BaseModel):
    """
    One flat model with a per-type validator rather than a discriminated union:
    a union reports "no variant matched" for a single bad field, which is not a
    422 anybody can act on.
    """

    kind: str | None = None
    cell: float | None = None
    bbox: list[float] | None = None


class CreateGisJobRequest(BaseModel):
    layer_type: str
    name: str
    files: list[GisFileSpec] = Field(default_factory=list)
    options: GisOptions = Field(default_factory=GisOptions)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.1f} GB"
    if value >= 1024**2:
        return f"{value / 1024**2:.0f} MB"
    if value >= 1024:
        return f"{value / 1024:.0f} KB"
    return f"{value} B"


def _iso(value: datetime | None) -> str | None:
    """ISO-8601 UTC with a trailing Z, which is what the frontend parses."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _stmt(sql: str, params: dict[str, Any]):
    """
    text() with every list parameter marked expanding.

    `IN :names` with an expanding bindparam is rendered as a plain IN list,
    which pg8000 can bind. A PostgreSQL `= ANY(:names)` would need real array
    type inference that the pg8000 driver does not do from a bare text() query.
    """
    statement = text(sql)
    expanding = [
        bindparam(name, expanding=True)
        for name, value in params.items()
        if isinstance(value, list)
    ]
    return statement.bindparams(*expanding) if expanding else statement


def _as_json(value: Any, fallback: Any) -> Any:
    """JSONB comes back parsed on pg8000, but a text column would not."""
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def _validate_options(layer_type: str, options: GisOptions) -> dict[str, Any]:
    """
    Normalise the flat options to the per-type shape the worker expects.
    Inapplicable fields are dropped rather than rejected, so a frontend that
    keeps stale form state around does not get a 400 for it.
    """
    result: dict[str, Any] = {}

    if layer_type in ("tiff", "lidar"):
        allowed = ("dem", "dsm", "raster") if layer_type == "tiff" else ("dem", "dsm")
        kind = options.kind or DEFAULT_OPTIONS[layer_type]["kind"]
        if kind not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"kind must be one of {', '.join(allowed)} for {layer_type}",
            )
        result["kind"] = kind

    if layer_type == "lidar":
        cell = options.cell if options.cell is not None else DEFAULT_OPTIONS["lidar"]["cell"]
        cell = float(cell)
        if not (0.1 <= cell <= 50.0):
            raise HTTPException(
                status_code=400, detail="cell must be between 0.1 and 50.0 metres"
            )
        result["cell"] = cell

    if layer_type in ("osm", "geojson") and options.bbox is not None:
        bbox = options.bbox
        if len(bbox) != 4:
            raise HTTPException(status_code=400, detail="bbox must be [minLon, minLat, maxLon, maxLat]")
        min_lon, min_lat, max_lon, max_lat = (float(v) for v in bbox)
        if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
            raise HTTPException(status_code=400, detail="bbox longitudes must be between -180 and 180")
        if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
            raise HTTPException(status_code=400, detail="bbox latitudes must be between -90 and 90")
        if min_lon >= max_lon or min_lat >= max_lat:
            raise HTTPException(status_code=400, detail="bbox needs min < max on both axes")
        result["bbox"] = [min_lon, min_lat, max_lon, max_lat]

    return result


def _validate_files(layer_type: str, files: list[GisFileSpec]) -> None:
    if not files:
        raise HTTPException(status_code=400, detail="files must not be empty")

    max_files = MAX_FILES[layer_type]
    if len(files) > max_files:
        raise HTTPException(
            status_code=400,
            detail=f"{layer_type} accepts {max_files} file(s); you sent {len(files)}",
        )

    extensions = ACCEPTED_EXTENSIONS[layer_type]
    max_size = CONFIG.max_bytes[layer_type]
    seen: set[str] = set()

    for spec in files:
        name = spec.filename.strip()
        if not name:
            raise HTTPException(status_code=400, detail="filename must not be empty")
        # The filename becomes part of an R2 key; a path separator would let a
        # caller write outside the job's own prefix.
        if "/" in name or "\\" in name or name.startswith("."):
            raise HTTPException(
                status_code=400,
                detail=f"{name} is not a valid filename (no path separators, no leading dot)",
            )
        if name in seen:
            raise HTTPException(
                status_code=400, detail=f"two files are named {name}; filenames must be unique"
            )
        seen.add(name)

        if match_extension(name, extensions) is None:
            raise HTTPException(
                status_code=400,
                detail=f"{name} is not a {layer_type} file — accepted: {', '.join(extensions)}",
            )
        if spec.size_bytes and spec.size_bytes > max_size:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{name} is {_format_bytes(spec.size_bytes)}; the limit for "
                    f"{layer_type} is {_format_bytes(max_size)}"
                ),
            )


# ---------------------------------------------------------------------------
# Layer reads
# ---------------------------------------------------------------------------
# One shape for both tables, so the API can page over "all layers" the way the
# library UI presents them. This is the same union as the public.gis_layers
# view, widened with the columns the layer object needs.
_LAYER_UNION = """
    SELECT 'raster'::text AS geometry_class, r.id, r.name, r.layer_type, r.kind,
           NULL::text AS sublayer, r.source, r.src_crs, r.storage,
           r.overlay_path, r.geotiff_path, NULL::text AS geojson_key,
           NULL::integer AS feature_count, r.stats, r.properties,
           r.bounds, r.job_id, r.created_at
    FROM public.raster_layers r
    UNION ALL
    SELECT 'vector'::text, v.id, v.name, v.layer_type, NULL::text,
           v.sublayer, v.source, v.src_crs, 'r2'::text,
           NULL::text, NULL::text, v.geojson_key,
           v.feature_count, '{}'::jsonb, v.properties,
           v.bounds, v.job_id, v.created_at
    FROM public.vector_layers v
"""

_LAYER_SELECT = f"""
    SELECT l.geometry_class, l.id, l.name, l.layer_type, l.kind, l.sublayer, l.source,
           l.src_crs, l.storage, l.overlay_path, l.geotiff_path, l.geojson_key,
           l.feature_count, l.stats, l.properties, l.job_id, l.created_at,
           ST_XMin(l.bounds) AS min_lon, ST_YMin(l.bounds) AS min_lat,
           ST_XMax(l.bounds) AS max_lon, ST_YMax(l.bounds) AS max_lat,
           ST_AsGeoJSON(l.bounds) AS bounds_geojson
    FROM ({_LAYER_UNION}) l
"""


def _sign(key: str | None, storage: str) -> str | None:
    """
    Sign an R2 key. Rows written by the CLI loader hold a static
    '/overlays/x.png' path instead, which the frontend can fetch as-is.
    """
    if not key:
        return None
    if storage != "r2":
        return key
    return get_signed_url(key, expires_in=CONFIG.url_ttl)


def _layer_to_dict(row) -> dict[str, Any]:
    storage = row["storage"] or "r2"
    bounds = None
    if row["min_lon"] is not None:
        bounds = [row["min_lon"], row["min_lat"], row["max_lon"], row["max_lat"]]

    overlay_key = row["overlay_path"]
    geotiff_key = row["geotiff_path"]
    geojson_key = row["geojson_key"]

    return {
        "layer_id": row["id"],
        "layer_type": row["layer_type"],
        "geometry_class": row["geometry_class"],
        "name": row["name"],
        "kind": row["kind"],
        "sublayer": row["sublayer"],
        "source": row["source"],
        "src_crs": row["src_crs"],
        "bounds": bounds,
        "bounds_geojson": _as_json(row["bounds_geojson"], None),
        "overlay_key": overlay_key,
        "overlay_url": _sign(overlay_key, storage),
        "geotiff_key": geotiff_key,
        "geotiff_url": _sign(geotiff_key, storage),
        "geojson_key": geojson_key,
        "geojson_url": _sign(geojson_key, storage),
        "feature_count": row["feature_count"],
        "stats": _as_json(row["stats"], {}),
        "properties": _as_json(row["properties"], {}),
        "job_id": row["job_id"],
        "created_at": _iso(row["created_at"]),
        "url_expires_in": CONFIG.url_ttl,
    }


def _parse_bbox(bbox: str) -> dict[str, float]:
    """`minLon,minLat,maxLon,maxLat` -> bind params, or 400."""
    parts = [p.strip() for p in bbox.split(",")]
    if len(parts) != 4:
        raise HTTPException(status_code=400, detail="bbox must be minLon,minLat,maxLon,maxLat")
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="bbox values must be numbers") from exc
    if min_lon >= max_lon or min_lat >= max_lat:
        raise HTTPException(status_code=400, detail="bbox needs min < max on both axes")
    return {"min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat}


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------
_BUILDING_SELECT = """
    SELECT b.id, b.osm_id, b.name, b.layer_id, b.lidar_layer_id, b.job_id,
           b.ground_m, b.roof_m, b.height_m, b.footprint_area_m2,
           b.volume_prism_m3, b.volume_lidar_m3, b.coverage, b.cell_count,
           b.created_at, ST_AsGeoJSON(b.geom) AS geom_geojson
    FROM public.buildings b
"""


def _building_to_feature(row) -> dict[str, Any]:
    """One row as a GeoJSON Feature, so the response drops straight into a map."""
    return {
        "type": "Feature",
        "id": row["id"],
        "geometry": _as_json(row["geom_geojson"], None),
        "properties": {
            "osm_id": row["osm_id"],
            "name": row["name"],
            "layer_id": row["layer_id"],
            "lidar_layer_id": row["lidar_layer_id"],
            "job_id": row["job_id"],
            "ground_m": row["ground_m"],
            "roof_m": row["roof_m"],
            "height_m": row["height_m"],
            "footprint_area_m2": row["footprint_area_m2"],
            "volume_prism_m3": row["volume_prism_m3"],
            "volume_lidar_m3": row["volume_lidar_m3"],
            "coverage": row["coverage"],
            "cell_count": row["cell_count"],
            "created_at": _iso(row["created_at"]),
        },
    }


def _fetch_layers(session, where: list[str], params: dict[str, Any]) -> list[dict[str, Any]]:
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"{_LAYER_SELECT} {clause} ORDER BY l.created_at DESC, l.id"
    if "limit" in params:
        sql += " LIMIT :limit OFFSET :offset"
    rows = session.execute(_stmt(sql, params), params).mappings().all()
    return [_layer_to_dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Job reads
# ---------------------------------------------------------------------------
def _job_to_dict(row, layers: list[dict[str, Any]] | None = None, include_log: bool = True) -> dict[str, Any]:
    job = {
        "job_id": row["id"],
        "layer_type": row["layer_type"],
        "name": row["name"],
        "status": row["status"],
        "step": row["step"] if row["status"] == "running" else None,
        "error": row["error"],
        "error_kind": row["error_kind"],
        "options": _as_json(row["options"], {}),
        "input_files": _as_json(row["input_files"], []),
        "layer_ids": _as_json(row["layer_ids"], []),
        "output_prefix": row["output_prefix"],
        "created_at": _iso(row["created_at"]),
        "started_at": _iso(row["started_at"]),
        "finished_at": _iso(row["finished_at"]),
    }
    if include_log:
        job["log"] = row["log"]
        job["layers"] = layers or []
    return job


_JOB_COLUMNS = """
    id, layer_type, name, status, step, input_prefix, input_files, options,
    layer_ids, output_prefix, error, error_kind, log, created_at, started_at, finished_at
"""


def _get_job_row(session, job_id: str):
    row = session.execute(
        text(f"SELECT {_JOB_COLUMNS} FROM public.gis_jobs WHERE id = :id"), {"id": job_id}
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return row


def _pending_count(session) -> int:
    return session.execute(
        text("SELECT count(*) FROM public.gis_jobs WHERE status IN ('queued', 'running')")
    ).scalar_one()


# ---------------------------------------------------------------------------
# Routes — configuration
# ---------------------------------------------------------------------------
@router.get("/config")
async def get_gis_config() -> dict[str, Any]:
    """Every limit the frontend needs to reject a bad selection before uploading."""
    return {
        "layer_types": list(LAYER_TYPES),
        "accepted_extensions": {k: list(v) for k, v in ACCEPTED_EXTENSIONS.items()},
        "max_files": dict(MAX_FILES),
        "max_size_bytes": CONFIG.max_size_bytes(),
        "max_raster_pixels": CONFIG.max_raster_pixels,
        "max_lidar_cells": CONFIG.max_lidar_cells,
        "max_queue": CONFIG.max_queue,
        "url_ttl_seconds": CONFIG.url_ttl,
        "defaults": {k: dict(v) for k, v in DEFAULT_OPTIONS.items()},
        # Lets the frontend discover the gate instead of hardcoding it.
        "auth_required": True,
    }


# ---------------------------------------------------------------------------
# Routes — jobs
# ---------------------------------------------------------------------------
@router.post("/jobs", status_code=201, dependencies=[Protected])
async def create_gis_job(body: CreateGisJobRequest, session: SessionDep) -> dict[str, Any]:
    """Create a job and hand back one presigned PUT URL per declared file."""
    layer_type = body.layer_type
    if layer_type not in LAYER_TYPES:
        raise HTTPException(
            status_code=400, detail=f"layer_type must be one of {', '.join(LAYER_TYPES)}"
        )

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name must not be empty")

    _validate_files(layer_type, body.files)
    options = _validate_options(layer_type, body.options)

    job_id = str(uuid.uuid4())
    input_prefix = f"{CONFIG.input_prefix}/{job_id}/"
    input_files = [
        {
            "filename": spec.filename.strip(),
            "size_bytes": int(spec.size_bytes or 0),
            "key": f"{input_prefix}{spec.filename.strip()}",
        }
        for spec in body.files
    ]

    session.execute(
        text(
            """
            INSERT INTO public.gis_jobs
                (id, layer_type, name, status, input_prefix, input_files, options)
            VALUES
                (:id, :layer_type, :name, 'awaiting_upload', :input_prefix,
                 CAST(:input_files AS jsonb), CAST(:options AS jsonb))
            """
        ),
        {
            "id": job_id,
            "layer_type": layer_type,
            "name": name,
            "input_prefix": input_prefix,
            "input_files": json.dumps(input_files),
            "options": json.dumps(options),
        },
    )
    session.commit()

    return {
        "job_id": job_id,
        "layer_type": layer_type,
        "name": name,
        "status": "awaiting_upload",
        "input_prefix": input_prefix,
        "upload_urls": {
            entry["filename"]: get_upload_url(entry["key"], expires_in=CONFIG.url_ttl)
            for entry in input_files
        },
        "expires_in": CONFIG.url_ttl,
        "options": options,
    }


@router.post("/jobs/{job_id}/start", status_code=202, dependencies=[Protected])
async def start_gis_job(
    job_id: str, background_tasks: BackgroundTasks, session: SessionDep
) -> dict[str, Any]:
    """Verify the uploads landed, then hand the job to the background worker."""
    row = _get_job_row(session, job_id)

    if row["status"] != "awaiting_upload":
        raise HTTPException(
            status_code=409, detail=f"job already started (status={row['status']})"
        )

    pending = _pending_count(session)
    if pending >= CONFIG.max_queue:
        raise HTTPException(status_code=429, detail=f"GIS queue is full ({pending} pending)")

    layer_type = row["layer_type"]
    max_size = CONFIG.max_bytes[layer_type]
    declared = _as_json(row["input_files"], [])
    confirmed = []

    for entry in declared:
        key = entry.get("key") or f"{row['input_prefix']}{entry['filename']}"
        head = r2_head(key)
        if head is None:
            raise HTTPException(status_code=400, detail=f"missing upload: {entry['filename']}")
        size = int(head.get("ContentLength") or 0)
        if size > max_size:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{entry['filename']} is {_format_bytes(size)}; the limit for "
                    f"{layer_type} is {_format_bytes(max_size)}"
                ),
            )
        confirmed.append({"filename": entry["filename"], "size_bytes": size, "key": key})

    session.execute(
        text(
            """
            UPDATE public.gis_jobs
            SET status = 'queued', step = NULL, error = NULL, error_kind = NULL,
                input_files = CAST(:input_files AS jsonb), updated_at = now()
            WHERE id = :id
            """
        ),
        {"id": job_id, "input_files": json.dumps(confirmed)},
    )
    session.commit()

    # Imported here rather than at module scope so a broken GIS stack cannot
    # stop the whole API from importing.
    from gis_worker import run_gis_job

    background_tasks.add_task(run_gis_job, job_id)

    return {"job_id": job_id, "status": "queued", "queue_position": pending + 1}


@router.get("/jobs")
async def list_gis_jobs(
    session: SessionDep,
    status: str | None = None,
    layer_type: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    where: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if status:
        where.append("status IN :statuses")
        params["statuses"] = [s.strip() for s in status.split(",") if s.strip()]
    if layer_type:
        where.append("layer_type IN :layer_types")
        params["layer_types"] = [t.strip() for t in layer_type.split(",") if t.strip()]
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = session.execute(
        _stmt(f"SELECT count(*) FROM public.gis_jobs {clause}", params), params
    ).scalar_one()
    rows = session.execute(
        _stmt(
            f"SELECT {_JOB_COLUMNS} FROM public.gis_jobs {clause} "
            "ORDER BY created_at DESC, id LIMIT :limit OFFSET :offset",
            params,
        ),
        params,
    ).mappings().all()

    return {"jobs": [_job_to_dict(row, include_log=False) for row in rows], "total": total}


@router.get("/jobs/{job_id}")
async def get_gis_job(job_id: str, session: SessionDep) -> dict[str, Any]:
    row = _get_job_row(session, job_id)

    # A finished job carries its layers inline, signed and ready, so the map can
    # draw the result without a second round trip.
    layers: list[dict[str, Any]] = []
    if row["status"] == "done":
        layers = _fetch_layers(session, ["l.job_id = :job_id"], {"job_id": job_id})

    return _job_to_dict(row, layers=layers)


@router.delete("/jobs/{job_id}", dependencies=[Protected])
async def delete_gis_job(job_id: str, session: SessionDep) -> dict[str, Any]:
    """
    Cancel a job that has not started, or purge a finished one along with every
    layer and object it produced.
    """
    row = _get_job_row(session, job_id)
    status = row["status"]

    if status == "running":
        # FastAPI BackgroundTasks are not interruptible; pretending otherwise
        # would leave the row and the worker disagreeing.
        raise HTTPException(status_code=409, detail="job is running and cannot be cancelled")

    deleted_objects = 0
    try:
        deleted_objects += r2_delete_prefix(row["input_prefix"])
    except Exception:
        logger.warning("Could not delete inputs for GIS job %s", job_id, exc_info=True)

    if status in ("awaiting_upload", "queued"):
        session.execute(
            text(
                """
                UPDATE public.gis_jobs
                SET status = 'cancelled', step = NULL, finished_at = now(), updated_at = now()
                WHERE id = :id
                """
            ),
            {"id": job_id},
        )
        session.commit()
        return {
            "job_id": job_id,
            "status": "cancelled",
            "deleted_layers": 0,
            "deleted_objects": deleted_objects,
        }

    try:
        deleted_objects += r2_delete_prefix(f"{CONFIG.output_prefix}/{job_id}/")
    except Exception:
        logger.warning("Could not delete outputs for GIS job %s", job_id, exc_info=True)

    deleted_layers = 0
    for table in ("public.raster_layers", "public.vector_layers"):
        result = session.execute(
            text(f"DELETE FROM {table} WHERE job_id = :job_id"), {"job_id": job_id}
        )
        deleted_layers += result.rowcount or 0
    session.execute(text("DELETE FROM public.gis_jobs WHERE id = :id"), {"id": job_id})
    session.commit()

    return {
        "job_id": job_id,
        "status": "deleted",
        "deleted_layers": deleted_layers,
        "deleted_objects": deleted_objects,
    }


# ---------------------------------------------------------------------------
# Routes — layers
# ---------------------------------------------------------------------------
@router.get("/layers")
async def list_gis_layers(
    session: SessionDep,
    layer_type: str | None = None,
    kind: str | None = None,
    geometry_class: str | None = None,
    job_id: str | None = None,
    bbox: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    where: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}

    if layer_type:
        where.append("l.layer_type IN :layer_types")
        params["layer_types"] = [t.strip() for t in layer_type.split(",") if t.strip()]
    if kind:
        where.append("l.kind IN :kinds")
        params["kinds"] = [k.strip() for k in kind.split(",") if k.strip()]
    if geometry_class:
        if geometry_class not in ("raster", "vector"):
            raise HTTPException(status_code=400, detail="geometry_class must be raster or vector")
        where.append("l.geometry_class = :geometry_class")
        params["geometry_class"] = geometry_class
    if job_id:
        where.append("l.job_id = :job_id")
        params["job_id"] = job_id
    if bbox:
        params.update(_parse_bbox(bbox))
        where.append(
            "ST_Intersects(l.bounds, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))"
        )

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    total = session.execute(
        _stmt(f"SELECT count(*) FROM ({_LAYER_UNION}) l {clause}", params), params
    ).scalar_one()

    return {"layers": _fetch_layers(session, where, params), "total": total}


@router.get("/buildings")
async def list_buildings(
    session: SessionDep,
    bbox: str | None = None,
    layer_id: str | None = None,
    job_id: str | None = None,
    min_height: float | None = Query(None, ge=0),
    measured_only: bool = False,
    limit: int = Query(2000, ge=1, le=20000),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    """
    Building footprints with their LiDAR-derived height and volume, as a GeoJSON
    FeatureCollection the map can render directly.

    `height_m` is null where the LiDAR did not cover the footprint — render those
    distinctly rather than extruding them to zero. `measured_only=true` drops
    them instead.
    """
    where: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}

    if bbox:
        params.update(_parse_bbox(bbox))
        where.append(
            "ST_Intersects(b.geom, ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))"
        )
    if layer_id:
        where.append("b.layer_id = :layer_id")
        params["layer_id"] = layer_id
    if job_id:
        where.append("b.job_id = :job_id")
        params["job_id"] = job_id
    if min_height is not None:
        # NULL height_m fails this comparison, so a min_height filter implies
        # measured_only — no need for the caller to pass both.
        where.append("b.height_m >= :min_height")
        params["min_height"] = min_height
    if measured_only:
        where.append("b.height_m IS NOT NULL")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    total = session.execute(
        _stmt(f"SELECT count(*) FROM public.buildings b {clause}", params), params
    ).scalar_one()

    # Ordered by id so paging is stable; volume desc would be nicer for "biggest
    # first" but reshuffles as soon as a re-measure changes one row.
    sql = f"{_BUILDING_SELECT} {clause} ORDER BY b.id LIMIT :limit OFFSET :offset"
    rows = session.execute(_stmt(sql, params), params).mappings().all()

    return {
        "type": "FeatureCollection",
        "features": [_building_to_feature(row) for row in rows],
        "total": total,
        "returned": len(rows),
    }


@router.post("/measure-drawn", dependencies=[Protected])
async def measure_drawn(bbox: str | None = None) -> dict[str, Any]:
    """
    Measure user-drawn target outlines against LiDAR that is already indexed.

    Normally this happens on its own — when a LiDAR job lands, and when an
    outline is drawn. This endpoint is the third case: outlines that predate
    either trigger, which no future job will ever come back for.

    Synchronous, not a background job. It is a backfill you run by hand and the
    only thing you want from it is the count, which a fire-and-forget task
    cannot give you. A single tile's surfaces are tens of megabytes and a
    handful of footprints measure in seconds; a whole-country backfill over
    many tiles is the case that could outlast a proxy timeout, so pass a bbox.
    """
    # Imported here, not at module scope: gis_worker pulls in the native GIS
    # stack, and the API must still boot when that is the thing that is broken.
    from gis_worker import classify, measure_drawn_targets

    bounds = None
    if bbox:
        parsed = _parse_bbox(bbox)
        bounds = [
            parsed["min_lon"], parsed["min_lat"], parsed["max_lon"], parsed["max_lat"]
        ]

    try:
        return measure_drawn_targets(bounds)
    except Exception as exc:
        code, message = classify(exc)
        logger.warning("measure-drawn failed (%s)", code, exc_info=True)
        raise HTTPException(status_code=500, detail=message) from exc


@router.get("/layers/{layer_id}")
async def get_gis_layer(layer_id: str, session: SessionDep) -> dict[str, Any]:
    layers = _fetch_layers(session, ["l.id = :layer_id"], {"layer_id": layer_id})
    if not layers:
        raise HTTPException(status_code=404, detail="Layer not found")
    return layers[0]


@router.delete("/layers/{layer_id}", dependencies=[Protected])
async def delete_gis_layer(layer_id: str, session: SessionDep) -> dict[str, Any]:
    layers = _fetch_layers(session, ["l.id = :layer_id"], {"layer_id": layer_id})
    if not layers:
        raise HTTPException(status_code=404, detail="Layer not found")
    layer = layers[0]

    # Only ever delete inside the gis/ namespace — a legacy row's
    # '/overlays/x.png' is a static asset this endpoint does not own.
    keys = [
        key
        for key in (layer["overlay_key"], layer["geotiff_key"], layer["geojson_key"])
        if key and key.startswith(f"{CONFIG.output_prefix}/")
    ]
    deleted_objects = 0
    try:
        if layer["job_id"]:
            deleted_objects = r2_delete_prefix(
                f"{CONFIG.output_prefix}/{layer['job_id']}/{layer_id}/"
            )
        elif keys:
            deleted_objects = r2_delete_keys(keys)
    except Exception:
        logger.warning("Could not delete objects for layer %s", layer_id, exc_info=True)

    table = (
        "public.raster_layers" if layer["geometry_class"] == "raster" else "public.vector_layers"
    )
    session.execute(text(f"DELETE FROM {table} WHERE id = :id"), {"id": layer_id})
    session.commit()

    return {"layer_id": layer_id, "deleted_objects": deleted_objects}


@router.get("/asset-url")
async def get_gis_asset_url(key: str = Query(...)) -> dict[str, Any]:
    """
    Re-sign one artifact whose URL has expired.

    Restricted to the gis/ prefix so this cannot become an open signer for the
    whole bucket — a weakness the older /splat-url endpoint has.
    """
    if not key.startswith("gis/"):
        raise HTTPException(status_code=400, detail="key must be under the gis/ prefix")
    return {
        "url": get_signed_url(key, expires_in=CONFIG.url_ttl),
        "filename": key.split("/")[-1],
        "expires_in": CONFIG.url_ttl,
    }
