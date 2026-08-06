"""
The GIS background worker: R2 input -> the processing scripts -> R2 artifacts -> DB rows.

Entered through run_gis_job(job_id), which FastAPI's BackgroundTasks calls after
POST /gis/jobs/{id}/start. It is a plain `def` on purpose: Starlette runs a sync
background task in the anyio threadpool, whereas an `async def` would run on the
event loop and block every other request for the minutes a warp takes.

The task receives only a job id — never a Session and never an ORM instance. It
opens short-lived connections at the points it needs them (mark running, step
updates, finalize) and holds none across processing, because a connection idle
for the length of a LiDAR grid is a connection Cloud SQL has already dropped.
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text

from deps import engine
from gis_runtime import (
    ACCEPTED_EXTENSIONS,
    CONFIG,
    GisInputError,
    capture_stdout,
    check_disk,
    check_lidar_budget,
    check_raster_budget,
    gis_workspace,
    load_processors,
    match_extension,
    r2_delete_prefix,
    r2_download,
    r2_upload,
    slugify,
    tail_log,
)

logger = logging.getLogger(__name__)

# One job at a time. Combined with the queue cap enforced in the API, this is
# what keeps a 500 MB LiDAR tile from meeting a 300 MB GeoTIFF in a container
# sized for one of them.
_GIS_SLOT = threading.BoundedSemaphore(CONFIG.max_concurrency)

# Rough worst case for scratch: the input, the native grid, the warped GeoTIFF
# and the PNG all coexist on disk.
_DISK_HEADROOM_FACTOR = 4
_MIN_DISK = 256 * 1024 * 1024


@dataclass
class LayerResult:
    """One produced layer, ready to be uploaded and indexed."""

    layer_id: str
    geometry_class: str  # "raster" | "vector"
    layer_type: str
    name: str
    kind: str | None = None
    sublayer: str | None = None
    source: str | None = None
    src_crs: str | None = None
    bounds4326: list[float] | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)
    feature_count: int | None = None
    # Artifact name (which becomes the R2 object name) -> local path.
    artifacts: dict[str, Path] = field(default_factory=dict)
    # Filled in during the upload step.
    keys: dict[str, str] = field(default_factory=dict)
    size_bytes: int | None = None


# ---------------------------------------------------------------------------
# Job row access
# ---------------------------------------------------------------------------
def _load_job(conn, job_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        text(
            """
            SELECT id, layer_type, name, status, input_prefix, input_files, options
            FROM public.gis_jobs WHERE id = :id
            """
        ),
        {"id": job_id},
    ).mappings().first()
    return dict(row) if row else None


def _job_status(conn, job_id: str) -> str | None:
    row = conn.execute(
        text("SELECT status FROM public.gis_jobs WHERE id = :id"), {"id": job_id}
    ).first()
    return row[0] if row else None


def _set_step(job_id: str, step: str, log: str | None = None) -> None:
    """Publish progress. Deliberately its own tiny transaction."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE public.gis_jobs
                    SET step = :step,
                        log = COALESCE(:log, log),
                        updated_at = now()
                    WHERE id = :id
                    """
                ),
                {"id": job_id, "step": step, "log": log},
            )
    except Exception:
        # A progress update is never worth failing a job over.
        logger.warning("Could not record step %s for GIS job %s", step, job_id, exc_info=True)


def _fail_job(job_id: str, kind: str, message: str, log: str = "") -> None:
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE public.gis_jobs
                    SET status = 'failed', step = NULL, error = :error, error_kind = :kind,
                        log = :log, finished_at = now(), updated_at = now()
                    WHERE id = :id
                    """
                ),
                {"id": job_id, "error": message, "kind": kind, "log": log or None},
            )
    except Exception:
        logger.error("Could not mark GIS job %s failed", job_id, exc_info=True)


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------
def classify(exc: BaseException) -> tuple[str, str]:
    """
    Map an exception to (error_kind, user-facing message).

    The processing scripts raise plain ValueErrors with good messages; those are
    matched on text, which is why the matched strings are cited to their source.
    """
    if isinstance(exc, GisInputError):
        return exc.kind, exc.message

    if isinstance(exc, MemoryError):
        return "oom", "The worker ran out of memory processing this file."

    if isinstance(exc, OSError) and (
        exc.errno == 28 or "No space left" in str(exc)
    ):  # ENOSPC
        return "disk_full", "The worker ran out of scratch disk space."

    message = str(exc)

    # gis_common.reproject_geotiff_to_wgs84 and process_lidar._horizontal_crs.
    if "has no CRS" in message:
        return (
            "no_crs",
            "This file carries no CRS, so it cannot be placed on a map. Re-export it with one, "
            "e.g. gdal_edit.py -a_srs EPSG:32635 file.tif",
        )

    # process_lidar.rasterize_laz — rewritten from the script's CLI advice
    # ("re-run with --kind dsm") into something the API's own vocabulary.
    if "No ground-classified" in message:
        return (
            "no_ground_points",
            "This point cloud has no ground-classified (class 2) points, so a DEM cannot be "
            'built from it. Retry with kind="dsm" to grid the top surface instead.',
        )

    if "Could not detect geometry type" in message or "no features" in message.lower():
        return "empty_result", "No features survived processing, so there is nothing to draw."

    # A missing shared library is a broken deployment, not a bad upload, and it
    # will fail identically for every file the user tries. Saying so beats
    # "unexpected error" — that sent us hunting through a LiDAR tile that turned
    # out to be perfectly valid. The processing libraries are imported lazily,
    # so this only ever surfaces mid-job, never at boot.
    if isinstance(exc, ImportError):
        missing = getattr(exc, "name", None) or message
        return (
            "dependency_missing",
            f"The server is missing a processing dependency ({missing}). This is a "
            "deployment problem, not a problem with your file — retrying will not help.",
        )

    for module_name, class_names, kind in (
        ("rasterio.errors", ("RasterioIOError",), "unreadable"),
        ("pyogrio.errors", ("DataSourceError", "DataLayerError"), "unreadable"),
    ):
        module = _safe_import(module_name)
        if module is None:
            continue
        for class_name in class_names:
            error_class = getattr(module, class_name, None)
            if error_class is not None and isinstance(exc, error_class):
                return kind, f"The file could not be read: {message}"

    return "internal", f"Processing failed: {message}" if message else "Processing failed."


def _safe_import(module_name: str):
    """Import for an isinstance check only — a missing optional dep is not an error."""
    try:
        __import__(module_name)
    except Exception:
        return None
    return sys.modules.get(module_name)


# ---------------------------------------------------------------------------
# Building heights
#
# Heights need a LiDAR DSM/DEM pair and OSM footprints covering the same ground,
# and those arrive as two separate uploads in either order. So both sides look
# for their counterpart in the library once their own layers are indexed: upload
# a tile then an extract, or an extract then a tile, and the measurement happens
# on the second one either way.
#
# Every step is best-effort. No counterpart, no overlap, or a failed measurement
# all leave the job successful with its layers intact — heights are a bonus on
# top of the layer the user actually asked for.
# ---------------------------------------------------------------------------
_BBOX_KEYS = ("min_lon", "min_lat", "max_lon", "max_lat")


def _bbox_params(bounds: list[float] | None) -> dict[str, float] | None:
    if not bounds or len(bounds) != 4:
        return None
    return dict(zip(_BBOX_KEYS, (float(v) for v in bounds)))


def _find_overlapping_buildings(bounds: list[float] | None) -> tuple[str, str] | None:
    """Newest indexed buildings layer intersecting `bounds` -> (layer_id, key)."""
    params = _bbox_params(bounds)
    if params is None:
        return None
    sql = text(
        """
        SELECT id, geojson_key
        FROM public.vector_layers
        WHERE sublayer = 'buildings'
          AND bounds IS NOT NULL
          AND geojson_key IS NOT NULL
          AND ST_Intersects(
                bounds,
                ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))
        ORDER BY created_at DESC
        LIMIT 1
        """
    )
    with engine.begin() as conn:
        row = conn.execute(sql, params).first()
    return (row[0], row[1]) if row else None


def _find_overlapping_lidar(bounds: list[float] | None) -> tuple[str, str, str] | None:
    """Newest LiDAR layer with *both* metric surfaces -> (layer_id, dem, dsm)."""
    params = _bbox_params(bounds)
    if params is None:
        return None
    sql = text(
        """
        SELECT id, properties ->> 'native_dem', properties ->> 'native_dsm'
        FROM public.raster_layers
        WHERE layer_type = 'lidar'
          AND properties ->> 'native_dem' IS NOT NULL
          AND properties ->> 'native_dsm' IS NOT NULL
          AND bounds IS NOT NULL
          AND ST_Intersects(
                bounds,
                ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))
        ORDER BY created_at DESC
        LIMIT 1
        """
    )
    with engine.begin() as conn:
        row = conn.execute(sql, params).first()
    return (row[0], row[1], row[2]) if row else None


def _measure_buildings(
    job_id: str,
    layer_type: str,
    layers: list[LayerResult],
    processors,
    work_root: Path,
) -> str | None:
    """
    Measure heights for whatever this job just made, if its counterpart exists.

    Returns a line for the job log, or None when there was nothing to do.
    """
    dem = dsm = footprints = None
    raster_layer_id = vector_layer_id = None

    if layer_type == "lidar":
        layer = layers[0]
        dem = layer.artifacts.get("native_dem.tif")
        dsm = layer.artifacts.get("native_dsm.tif")
        # The surface the user asked for is under its generic name.
        if layer.kind == "dem":
            dem = dem or layer.artifacts.get("native.tif")
        elif layer.kind == "dsm":
            dsm = dsm or layer.artifacts.get("native.tif")
        raster_layer_id = layer.layer_id

        if not (dem and dsm):
            return "[heights] skipped — this tile yielded only one surface"

        match = _find_overlapping_buildings(layer.bounds4326)
        if not match:
            return "[heights] skipped — no building footprints cover this tile yet"
        vector_layer_id, key = match
        footprints = work_root / "counterpart_buildings.geojson"
        r2_download(key, footprints)

    elif layer_type == "osm":
        layer = next((item for item in layers if item.sublayer == "buildings"), None)
        if layer is None:
            return None
        footprints = layer.artifacts.get("features.geojson")
        vector_layer_id = layer.layer_id

        match = _find_overlapping_lidar(layer.bounds4326)
        if not match:
            return "[heights] skipped — no LiDAR tile covers these footprints yet"
        raster_layer_id, dem_key, dsm_key = match
        dem = work_root / "counterpart_dem.tif"
        dsm = work_root / "counterpart_dsm.tif"
        r2_download(dem_key, dem)
        r2_download(dsm_key, dsm)
    else:
        return None

    if not (dem and dsm and footprints):
        return None

    measured = work_root / "buildings_heights_4326.geojson"
    summary = processors.heights.process_buildings(dsm, dem, footprints, measured)
    stored = processors.loader.upsert_buildings(
        engine,
        measured,
        layer_id=vector_layer_id,
        lidar_layer_id=raster_layer_id,
        job_id=job_id,
    )
    return (
        f"[heights] {summary['measured']}/{summary['buildings']} footprints measured, "
        f"{stored} written to public.buildings "
        f"(median {summary['height_m']['median']:.1f} m, "
        f"{summary['total_volume_lidar_m3']:,.0f} m3 total)"
    )


# ---------------------------------------------------------------------------
# Layer id generation (server-side only)
# ---------------------------------------------------------------------------
def _layer_id(layer_type: str, name: str, job_id: str, suffix: str | None = None) -> str:
    """
    {layer_type}_{slug(name)}_{job_id[:8]}[_{suffix}].

    Never client-supplied: the indexing step upserts ON CONFLICT (id), so a
    caller who could choose an id could silently overwrite someone else's layer.
    """
    base = f"{layer_type}_{slugify(name)}_{job_id[:8]}"
    return f"{base}_{suffix}" if suffix else base


# ---------------------------------------------------------------------------
# Per-type handlers — each calls the unmodified CLI script
# ---------------------------------------------------------------------------
def _handle_tiff(processors, ws, job, inputs: list[tuple[str, Path]]) -> list[LayerResult]:
    original, src = inputs[0]
    options = job["options"] or {}
    kind = options.get("kind", "dem")
    layer_id = _layer_id("tiff", job["name"], job["id"])

    layer = processors.raster.process_raster(src, layer_id, job["name"], kind)

    # Reconstruct artifact paths from the returned dataclass rather than guessing:
    # they are relative to the rebound root, and it is authoritative.
    geotiff = ws.root / layer.geotiff_path
    overlay = ws.root / "public" / layer.overlay_path.lstrip("/")

    return [
        LayerResult(
            layer_id=layer_id,
            geometry_class="raster",
            layer_type="tiff",
            name=layer.name,
            kind=layer.kind,
            source=original,
            src_crs=layer.src_crs,
            bounds4326=list(layer.bounds4326),
            stats=dict(layer.stats),
            properties=dict(layer.properties),
            artifacts={"overlay.png": overlay, "wgs84.tif": geotiff},
        )
    ]


def _handle_lidar(processors, ws, job, inputs: list[tuple[str, Path]]) -> list[LayerResult]:
    original, src = inputs[0]
    options = job["options"] or {}
    kind = options.get("kind", "dem")
    cell = float(options.get("cell", 1.0))
    layer_id = _layer_id("lidar", job["name"], job["id"])

    layer = processors.lidar.process_lidar(src, layer_id, job["name"], kind, cell)

    geotiff = ws.root / layer.geotiff_path
    overlay = ws.root / "public" / layer.overlay_path.lstrip("/")
    artifacts = {"overlay.png": overlay, "wgs84.tif": geotiff}

    def _native_of(produced) -> Path | None:
        relative = (produced.properties or {}).get("native_geotiff")
        if not relative:
            return None
        path = ws.root / relative
        return path if path.exists() else None

    native = _native_of(layer)
    if native:
        artifacts["native.tif"] = native

    # Grid the companion surface too. Building heights are DSM minus DEM, and
    # both have to come off the same tile at the same cell size, so producing
    # only the kind the user asked for would make the pair impossible to
    # reconstruct later. It costs a second pass over the point cloud.
    #
    # Non-fatal by design: --kind dem legitimately fails on a cloud with no
    # ground-classified returns, and that must not sink the layer the user
    # actually asked for.
    other = "dsm" if kind == "dem" else "dem"
    try:
        companion = processors.lidar.process_lidar(
            src, f"{layer_id}_{other}", job["name"], other, cell
        )
        companion_native = _native_of(companion)
        if companion_native:
            artifacts[f"native_{other}.tif"] = companion_native
    except Exception:
        logger.info(
            "GIS job %s: no %s companion surface (heights will need another tile)",
            job["id"], other, exc_info=True,
        )

    return [
        LayerResult(
            layer_id=layer_id,
            geometry_class="raster",
            layer_type="lidar",
            name=layer.name,
            kind=layer.kind,
            source=original,
            src_crs=layer.src_crs,
            bounds4326=list(layer.bounds4326),
            stats=dict(layer.stats),
            properties=dict(layer.properties),
            artifacts=artifacts,
        )
    ]


def _handle_osm(processors, ws, job, inputs: list[tuple[str, Path]]) -> list[LayerResult]:
    original, src = inputs[0]
    options = job["options"] or {}
    bbox = options.get("bbox")

    summary = processors.vectors.process_osm(src, bbox=bbox)

    results: list[LayerResult] = []
    for sublayer in ("buildings", "roads"):
        entry = summary.get(sublayer) or {}
        count = int(entry.get("count") or 0)
        if count == 0:
            # A written-but-empty GeoJSON is not a layer; skipping it here is
            # what keeps zero-feature rows out of the library.
            continue
        geojson = ws.root / entry["path"]
        results.append(
            LayerResult(
                layer_id=_layer_id("osm", job["name"], job["id"], sublayer),
                geometry_class="vector",
                layer_type="osm",
                name=f"{job['name']} — {sublayer}",
                sublayer=sublayer,
                source=original,
                src_crs="EPSG:4326",
                bounds4326=list(entry.get("bounds4326") or []) or None,
                feature_count=count,
                properties={"bbox_applied": list(bbox)} if bbox else {},
                artifacts={"features.geojson": geojson},
            )
        )

    if not results:
        raise GisInputError(
            "empty_result",
            "No buildings or roads were found in this extract. If you set a bounding box, "
            "widen or clear it.",
        )
    return results


def _handle_geojson(processors, ws, job, inputs: list[tuple[str, Path]]) -> list[LayerResult]:
    import pyogrio

    options = job["options"] or {}
    bbox = options.get("bbox")
    multi = len(inputs) > 1

    results: list[LayerResult] = []
    for index, (original, src) in enumerate(inputs, start=1):
        summary = processors.vectors.process_regions(src, bbox=bbox)
        count = int((summary or {}).get("count") or 0)
        if count == 0:
            continue

        # process_regions does not report the source CRS, so read it separately —
        # a header-only call.
        try:
            src_crs = pyogrio.read_info(src).get("crs") or "EPSG:4326"
        except Exception:
            src_crs = None

        name = original if multi else job["name"]
        results.append(
            LayerResult(
                layer_id=_layer_id(
                    "geojson", job["name"], job["id"], str(index) if multi else None
                ),
                geometry_class="vector",
                layer_type="geojson",
                name=name,
                sublayer="features",
                source=original,
                src_crs=src_crs,
                bounds4326=list(summary.get("bounds4326") or []) or None,
                feature_count=count,
                properties={"bbox_applied": list(bbox)} if bbox else {},
                artifacts={"features.geojson": ws.root / summary["path"]},
            )
        )

    if not results:
        raise GisInputError(
            "empty_result",
            "No features survived processing. If you set a bounding box, widen or clear it.",
        )
    return results


_HANDLERS = {
    "tiff": _handle_tiff,
    "lidar": _handle_lidar,
    "osm": _handle_osm,
    "geojson": _handle_geojson,
}


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------
# ST_MakeEnvelope(x, y, x, y, 4326) returns a POINT, which violates
# GEOMETRY(Polygon, 4326) and aborts the insert — reachable with a single-point
# GeoJSON, or a raster one pixel wide. Pad any degenerate axis.
_PAD = 1e-9


def _envelope_params(bounds: list[float] | None) -> dict[str, float] | None:
    if not bounds or len(bounds) != 4:
        return None
    min_lon, min_lat, max_lon, max_lat = (float(v) for v in bounds)
    if max_lon <= min_lon:
        max_lon = min_lon + _PAD
    if max_lat <= min_lat:
        max_lat = min_lat + _PAD
    return {
        "min_lon": min_lon,
        "min_lat": min_lat,
        "max_lon": max_lon,
        "max_lat": max_lat,
    }


_RASTER_UPSERT = text(
    """
    INSERT INTO public.raster_layers
        (id, name, kind, layer_type, storage, source, src_crs, overlay_path, geotiff_path,
         stats, properties, bounds, job_id)
    VALUES
        (:id, :name, :kind, :layer_type, 'r2', :source, :src_crs, :overlay_path, :geotiff_path,
         CAST(:stats AS jsonb), CAST(:properties AS jsonb),
         ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326), :job_id)
    ON CONFLICT (id) DO UPDATE SET
        name         = EXCLUDED.name,
        kind         = EXCLUDED.kind,
        layer_type   = EXCLUDED.layer_type,
        storage      = EXCLUDED.storage,
        source       = EXCLUDED.source,
        src_crs      = EXCLUDED.src_crs,
        overlay_path = EXCLUDED.overlay_path,
        geotiff_path = EXCLUDED.geotiff_path,
        stats        = EXCLUDED.stats,
        properties   = EXCLUDED.properties,
        bounds       = EXCLUDED.bounds,
        job_id       = EXCLUDED.job_id
    """
)

_VECTOR_UPSERT_TEMPLATE = """
    INSERT INTO public.vector_layers
        (id, name, layer_type, sublayer, source, src_crs, geojson_key, feature_count,
         size_bytes, properties, bounds, job_id)
    VALUES
        (:id, :name, :layer_type, :sublayer, :source, :src_crs, :geojson_key, :feature_count,
         :size_bytes, CAST(:properties AS jsonb), {bounds}, :job_id)
    ON CONFLICT (id) DO UPDATE SET
        name          = EXCLUDED.name,
        layer_type    = EXCLUDED.layer_type,
        sublayer      = EXCLUDED.sublayer,
        source        = EXCLUDED.source,
        src_crs       = EXCLUDED.src_crs,
        geojson_key   = EXCLUDED.geojson_key,
        feature_count = EXCLUDED.feature_count,
        size_bytes    = EXCLUDED.size_bytes,
        properties    = EXCLUDED.properties,
        bounds        = EXCLUDED.bounds,
        job_id        = EXCLUDED.job_id
"""


def _index_layers(job_id: str, layers: list[LayerResult], log: str) -> None:
    """Insert every layer row and finalize the job in a single transaction."""
    with engine.begin() as conn:
        for layer in layers:
            envelope = _envelope_params(layer.bounds4326)
            if layer.geometry_class == "raster":
                if envelope is None:
                    raise GisInputError(
                        "internal",
                        f"{layer.layer_id} produced no WGS84 bounds, so it cannot be placed.",
                    )
                conn.execute(
                    _RASTER_UPSERT,
                    {
                        "id": layer.layer_id,
                        "name": layer.name,
                        "kind": layer.kind or "raster",
                        "layer_type": layer.layer_type,
                        "source": layer.source,
                        "src_crs": layer.src_crs,
                        "overlay_path": layer.keys.get("overlay.png"),
                        "geotiff_path": layer.keys.get("wgs84.tif"),
                        "stats": json.dumps(layer.stats),
                        "properties": json.dumps(layer.properties),
                        "job_id": job_id,
                        **envelope,
                    },
                )
            else:
                bounds_sql = (
                    "ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)"
                    if envelope
                    else "NULL"
                )
                conn.execute(
                    text(_VECTOR_UPSERT_TEMPLATE.format(bounds=bounds_sql)),
                    {
                        "id": layer.layer_id,
                        "name": layer.name,
                        "layer_type": layer.layer_type,
                        "sublayer": layer.sublayer or "features",
                        "source": layer.source,
                        "src_crs": layer.src_crs,
                        "geojson_key": layer.keys.get("features.geojson"),
                        "feature_count": layer.feature_count or 0,
                        "size_bytes": layer.size_bytes,
                        "properties": json.dumps(layer.properties),
                        "job_id": job_id,
                        **(envelope or {}),
                    },
                )

        conn.execute(
            text(
                """
                UPDATE public.gis_jobs
                SET status = 'done', step = NULL, error = NULL, error_kind = NULL,
                    layer_ids = CAST(:layer_ids AS jsonb), output_prefix = :output_prefix,
                    log = :log, finished_at = now(), updated_at = now()
                WHERE id = :id
                """
            ),
            {
                "id": job_id,
                "layer_ids": json.dumps([layer.layer_id for layer in layers]),
                "output_prefix": f"{CONFIG.output_prefix}/{job_id}/",
                "log": log or None,
            },
        )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def run_gis_job(job_id: str) -> None:
    """
    BackgroundTasks entrypoint. Sync by design (see the module docstring), and
    it never raises: every failure path ends with the job row marked failed.
    """
    try:
        with engine.begin() as conn:
            job = _load_job(conn, job_id)
        if job is None:
            logger.warning("GIS job %s vanished before the worker started", job_id)
            return
        if job["status"] != "queued":
            logger.info("GIS job %s is %s, not queued — worker exiting", job_id, job["status"])
            return
    except Exception:
        logger.error("Could not read GIS job %s", job_id, exc_info=True)
        return

    if not _GIS_SLOT.acquire(timeout=CONFIG.slot_timeout):
        _fail_job(
            job_id,
            "queue_timeout",
            "The job waited too long for a free worker slot and was dropped.",
        )
        return

    try:
        # Cancel window: DELETE /gis/jobs/{id} can flip a queued job to
        # cancelled while it sat waiting for this slot.
        with engine.begin() as conn:
            status = _job_status(conn, job_id)
        if status != "queued":
            logger.info("GIS job %s became %s while queued — not running", job_id, status)
            return
        _run_job_locked(job_id, job)
    except Exception:
        logger.error("GIS job %s failed outside its own error handling", job_id, exc_info=True)
        _fail_job(job_id, "internal", "Processing failed unexpectedly.")
    finally:
        _GIS_SLOT.release()


def _run_job_locked(job_id: str, job: dict[str, Any]) -> None:
    layer_type = job["layer_type"]
    declared = job["input_files"] or []
    log_lines: list[str] = []
    captured = ""

    with engine.begin() as conn:
        conn.execute(
            text(
                """
                UPDATE public.gis_jobs
                SET status = 'running', step = 'downloading',
                    started_at = COALESCE(started_at, now()), updated_at = now()
                WHERE id = :id
                """
            ),
            {"id": job_id},
        )

    CONFIG.tmp_dir.mkdir(parents=True, exist_ok=True)
    work_root = Path(tempfile.mkdtemp(prefix=f"gis-{job_id[:8]}-", dir=CONFIG.tmp_dir)).resolve()

    try:
        # ---- download ---------------------------------------------------
        declared_bytes = sum(int(f.get("size_bytes") or 0) for f in declared)
        check_disk(work_root, max(_MIN_DISK, declared_bytes * _DISK_HEADROOM_FACTOR))

        inputs: list[tuple[str, Path]] = []
        input_dir = work_root / "input"
        input_dir.mkdir(parents=True, exist_ok=True)

        for index, entry in enumerate(declared, start=1):
            original = entry["filename"]
            key = entry.get("key") or f"{job['input_prefix']}{original}"
            local = input_dir / _local_name(layer_type, job, original, index, len(declared))
            size = r2_download(key, local)
            log_lines.append(f"[fetch] {original} ({size:,} bytes)")
            inputs.append((original, local))

        if not inputs:
            raise GisInputError("missing_input", "This job has no uploaded input files.")

        # ---- preflight --------------------------------------------------
        _set_step(job_id, "preflight", "\n".join(log_lines))
        options = job["options"] or {}
        if layer_type == "tiff":
            info = check_raster_budget(
                inputs[0][1], CONFIG.max_raster_pixels, display_name=inputs[0][0]
            )
            log_lines.append(
                f"[preflight] {info['width']}x{info['height']} px, CRS {info['src_crs']}"
            )
        elif layer_type == "lidar":
            info = check_lidar_budget(
                inputs[0][1],
                float(options.get("cell", 1.0)),
                CONFIG.max_lidar_cells,
                display_name=inputs[0][0],
            )
            log_lines.append(
                f"[preflight] {info['point_count']:,} points -> "
                f"{info['cols']:,}x{info['rows']:,} grid ({info['cells']:,} cells)"
            )

        # ---- process ----------------------------------------------------
        _set_step(job_id, "processing", "\n".join(log_lines))
        handler = _HANDLERS[layer_type]
        with gis_workspace(work_root) as ws:
            with capture_stdout() as buffer:
                try:
                    layers = handler(load_processors(), ws, job, inputs)
                finally:
                    captured = tail_log(buffer)

        log = "\n".join(log_lines + ([captured] if captured else []))

        # ---- upload -----------------------------------------------------
        _set_step(job_id, "uploading", log)
        for layer in layers:
            prefix = f"{CONFIG.output_prefix}/{job_id}/{layer.layer_id}"
            for artifact_name, local_path in layer.artifacts.items():
                key = f"{prefix}/{artifact_name}"
                size = r2_upload(local_path, key)
                layer.keys[artifact_name] = key
                if artifact_name == "features.geojson":
                    layer.size_bytes = size
                    layer.properties["size_bytes"] = size
            # The local repo-relative path the script recorded is meaningless to
            # a client; replace it with the key that is. `native_dem`/`native_dsm`
            # are how a later job finds the metric rasters it needs to measure
            # building heights — the surface's own kind names the primary one.
            if "native.tif" in layer.keys:
                layer.properties["native_geotiff"] = layer.keys["native.tif"]
                if layer.kind in ("dem", "dsm"):
                    layer.properties[f"native_{layer.kind}"] = layer.keys["native.tif"]
            for artifact_name, key in layer.keys.items():
                if artifact_name in ("native_dem.tif", "native_dsm.tif"):
                    layer.properties[artifact_name[: -len(".tif")]] = key

        # ---- building heights (best-effort) ------------------------------
        # Before indexing, not after: _index_layers writes status='done' and the
        # log in one transaction, so anything appended afterwards is never
        # stored. Nothing here needs this job's own rows — the counterpart is
        # always a layer some earlier job indexed — and the artifacts it does
        # need are still on local disk until the workspace is torn down.
        if layer_type in ("lidar", "osm"):
            _set_step(job_id, "measuring", log)
            try:
                # Re-enter the workspace: building_heights writes through
                # gis_common's path globals, which must stay rebound at the job
                # directory rather than at the repo.
                with gis_workspace(work_root):
                    note = _measure_buildings(
                        job_id, layer_type, layers, load_processors(), work_root
                    )
            except Exception:
                logger.warning("GIS job %s: building heights failed", job_id, exc_info=True)
                note = "[heights] failed — the layers above are unaffected"
            if note:
                log_lines.append(note)
                log = "\n".join(log_lines + ([captured] if captured else []))

        # ---- index ------------------------------------------------------
        _set_step(job_id, "indexing", log)
        _index_layers(job_id, layers, log)
        logger.info("GIS job %s produced %d layer(s)", job_id, len(layers))

        # Inputs have served their purpose; the artifacts are what gets served.
        try:
            r2_delete_prefix(job["input_prefix"])
        except Exception:
            logger.warning("Could not clean inputs for GIS job %s", job_id, exc_info=True)

    except Exception as exc:  # noqa: BLE001 — every failure must reach the row
        kind, message = classify(exc)
        log = "\n".join(log_lines + ([captured] if captured else []))
        if kind == "internal":
            logger.error("GIS job %s failed: %s", job_id, exc, exc_info=True)
        else:
            logger.info("GIS job %s failed (%s): %s", job_id, kind, message)
        _fail_job(job_id, kind, message, log)
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


def _local_name(layer_type: str, job: dict[str, Any], original: str, index: int, total: int) -> str:
    """
    A deterministic local filename, never the user's.

    process_vectors derives its *output* names from src.stem, so the input name
    decides the artifact name — and for .osm.pbf it strips its own compound
    suffix (process_vectors.py:150-151), which lands on exactly the layer id
    base. Sanitising here also keeps a hostile filename out of the filesystem,
    and avoids colliding with gis_common's well-known DATA_DIR/map.osm and
    PUBLIC_DIR/ro.json, which the scripts special-case by path equality.
    """
    extension = match_extension(original, ACCEPTED_EXTENSIONS[layer_type]) or ""
    if layer_type == "osm":
        base = _layer_id("osm", job["name"], job["id"])
    elif layer_type == "geojson":
        base = _layer_id("geojson", job["name"], job["id"], str(index) if total > 1 else None)
    elif layer_type == "lidar":
        base = _layer_id("lidar", job["name"], job["id"])
    else:
        base = _layer_id("tiff", job["name"], job["id"])
    return f"{base}{extension}"
