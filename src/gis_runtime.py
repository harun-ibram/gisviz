"""
The bridge between the FastAPI app and the CLI processing scripts
(gis_common.py, process_raster.py, process_lidar.py, process_vectors.py),
which live alongside this module in src/ and double as standalone CLI tools.

Three jobs:

  * import  — load the four modules lazily, so the ~2-4 s / ~200 MB GDAL
              import is never paid at app startup. They need no package
              __init__.py (they import each other flatly, as
              `import gis_common as gc`), which is why they are not nested
              under a src subpackage.
  * rebind  — gis_workspace() temporarily points gis_common's module-level path
              globals at a per-job temp directory, so a processor writes into
              that directory instead of the repo. Every processor reads those
              globals as attribute lookups at call time, so this works with
              zero edits to the scripts, and the CLI (which never enters the
              context) behaves byte-identically.
  * guard   — header-only budget checks that reject an input before anything
              allocates, plus the R2 helpers the worker needs.

IMPORTANT: the GDAL/PROJ environment below must be set before anything imports
rasterio or pyogrio. GDAL_CACHEMAX in particular is read once at GDAL init and
otherwise defaults to 5% of host RAM, which on a shared Railway box is a lot of
memory handed to a block cache we do not need.
"""

from __future__ import annotations

import os

os.environ.setdefault("GDAL_CACHEMAX", "256")  # MB
os.environ.setdefault("GDAL_NUM_THREADS", "1")
os.environ.setdefault("OSM_MAX_TMPFILE_SIZE", "100")  # MB, then spills to CPL_TMPDIR
os.environ.setdefault("CPL_TMPDIR", "/tmp")
os.environ.setdefault("PROJ_NETWORK", "OFF")

import contextlib  # noqa: E402
import io  # noqa: E402
import logging  # noqa: E402
import math  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from functools import lru_cache  # noqa: E402
from pathlib import Path  # noqa: E402
from types import ModuleType  # noqa: E402
from typing import Any, Iterator  # noqa: E402

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class GisInputError(Exception):
    """
    A failure the user can act on, carrying the `error_kind` the API reports.

    Anything else that escapes the worker is classified as `internal`.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        logger.warning("%s=%r is not a number; using %d", name, raw, default)
        return default


MB = 1024 * 1024

LAYER_TYPES = ("tiff", "osm", "geojson", "lidar")

ACCEPTED_EXTENSIONS: dict[str, list[str]] = {
    "tiff": [".tif", ".tiff"],
    "lidar": [".laz", ".las"],
    # ".osm.pbf" is listed explicitly so the longest-suffix match the frontend
    # does has something to match; GDAL's OSM driver reads all four.
    "osm": [".osm", ".pbf", ".xml", ".osm.pbf"],
    "geojson": [".geojson", ".json"],
}

MAX_FILES: dict[str, int] = {"tiff": 1, "lidar": 1, "osm": 1, "geojson": 10}

DEFAULT_OPTIONS: dict[str, dict[str, Any]] = {
    "tiff": {"kind": "dem"},
    "lidar": {"kind": "dem", "cell": 1.0},
}


@dataclass(frozen=True)
class GisConfig:
    scripts_dir_override: str | None
    tmp_dir: Path
    max_concurrency: int
    max_queue: int
    max_raster_pixels: int
    max_lidar_cells: int
    max_bytes: dict[str, int]
    url_ttl: int
    slot_timeout: int
    input_prefix: str = "gis/inputs"
    output_prefix: str = "gis/outputs"

    def max_size_bytes(self) -> dict[str, int]:
        return dict(self.max_bytes)


def _load_config() -> GisConfig:
    return GisConfig(
        scripts_dir_override=os.environ.get("GIS_SCRIPTS_DIR") or None,
        tmp_dir=Path(os.environ.get("GIS_TMP_DIR", "/tmp/gisviz")),
        max_concurrency=_env_int("GIS_MAX_CONCURRENCY", 1),
        max_queue=_env_int("GIS_MAX_QUEUE", 3),
        max_raster_pixels=_env_int("GIS_MAX_RASTER_PIXELS", 16_000_000),
        max_lidar_cells=_env_int("GIS_MAX_LIDAR_CELLS", 25_000_000),
        max_bytes={
            "tiff": _env_int("GIS_MAX_BYTES_TIFF", 300 * MB),
            "lidar": _env_int("GIS_MAX_BYTES_LIDAR", 500 * MB),
            "osm": _env_int("GIS_MAX_BYTES_OSM", 250 * MB),
            "geojson": _env_int("GIS_MAX_BYTES_GEOJSON", 100 * MB),
        },
        url_ttl=_env_int("GIS_URL_TTL", 3600),
        slot_timeout=_env_int("GIS_SLOT_TIMEOUT", 1800),
    )


CONFIG = _load_config()


# ---------------------------------------------------------------------------
# Loading the processing scripts
# ---------------------------------------------------------------------------
def _resolve_scripts_dir() -> Path:
    """
    Locate the processing scripts. They live alongside this module, so by
    default this is just this file's own directory — resolved from __file__
    rather than the cwd, because uvicorn's working directory depends on how
    the service was started. GIS_SCRIPTS_DIR remains as an override for a
    nonstandard layout (e.g. a deploy that splits src/ across images).
    """
    if CONFIG.scripts_dir_override:
        scripts_dir = Path(CONFIG.scripts_dir_override).expanduser().resolve()
    else:
        scripts_dir = Path(__file__).resolve().parent

    if not (scripts_dir / "gis_common.py").is_file():
        raise GisInputError(
            "internal",
            f"GIS processing scripts not found at {scripts_dir}. The deployment must include "
            "gis_common.py alongside the rest of src/, or GIS_SCRIPTS_DIR must point at it.",
        )
    return scripts_dir


@dataclass(frozen=True)
class Processors:
    """The script modules, once imported."""

    gc: ModuleType
    raster: ModuleType
    lidar: ModuleType
    vectors: ModuleType
    # Building heights + the PostGIS upsert for them. Unlike the four above,
    # these are only reached when a LiDAR tile and OSM footprints overlap.
    heights: ModuleType
    loader: ModuleType
    scripts_dir: Path


@lru_cache(maxsize=1)
def load_processors() -> Processors:
    """
    Import the processing scripts. Cached: the GDAL stack costs seconds and
    hundreds of megabytes, and is only paid once, on the first GIS job.
    """
    scripts_dir = _resolve_scripts_dir()
    path_entry = str(scripts_dir)
    if path_entry not in sys.path:
        sys.path.insert(0, path_entry)

    import building_heights
    import gis_common
    import load_gis
    import process_lidar
    import process_raster
    import process_vectors

    logger.info("Loaded GIS processors from %s", scripts_dir)
    return Processors(
        gc=gis_common,
        raster=process_raster,
        lidar=process_lidar,
        vectors=process_vectors,
        heights=building_heights,
        loader=load_gis,
        scripts_dir=scripts_dir,
    )


# ---------------------------------------------------------------------------
# Per-job workspace
# ---------------------------------------------------------------------------
@dataclass
class Workspace:
    root: Path
    input_dir: Path
    output_dir: Path
    overlay_dir: Path
    public_dir: Path


# Rebinding module globals is process-wide, so only one job may be inside a
# workspace at a time. Asserted rather than assumed: a future
# GIS_MAX_CONCURRENCY=2 must fail loudly instead of silently interleaving two
# jobs' output paths.
_WORKSPACE_LOCK = threading.Lock()

_REBOUND_NAMES = ("REPO_ROOT", "PUBLIC_DIR", "DATA_DIR", "OUTPUT_DIR", "OVERLAY_DIR")


@contextlib.contextmanager
def gis_workspace(root: Path) -> Iterator[Workspace]:
    """
    Point gis_common's path globals at `root` for the duration of the block.

    Layout is chosen so the derived paths the processors return stay exactly
    what they are on the CLI:

        root/public/overlays/{id}.png  ->  overlay_web_path() == "/overlays/{id}.png"
        root/output/{id}_4326.tif      ->  rel_to_repo()      == "output/{id}_4326.tif"
    """
    if not _WORKSPACE_LOCK.acquire(blocking=False):
        raise RuntimeError(
            "gis_workspace is already active in this process. It rebinds module globals, "
            "so it supports exactly one concurrent job (GIS_MAX_CONCURRENCY must stay 1)."
        )

    processors = load_processors()
    gc = processors.gc

    root = Path(root).resolve()
    workspace = Workspace(
        root=root,
        input_dir=root / "input",
        output_dir=root / "output",
        overlay_dir=root / "public" / "overlays",
        public_dir=root / "public",
    )
    for directory in (workspace.input_dir, workspace.output_dir, workspace.overlay_dir):
        directory.mkdir(parents=True, exist_ok=True)

    saved = {name: getattr(gc, name) for name in _REBOUND_NAMES}
    try:
        gc.REPO_ROOT = root
        gc.PUBLIC_DIR = workspace.public_dir
        gc.DATA_DIR = workspace.input_dir
        gc.OUTPUT_DIR = workspace.output_dir
        gc.OVERLAY_DIR = workspace.overlay_dir
        yield workspace
    finally:
        for name, value in saved.items():
            setattr(gc, name, value)
        _WORKSPACE_LOCK.release()


@contextlib.contextmanager
def capture_stdout() -> Iterator[io.StringIO]:
    """
    Collect the processors' prints so they can be shown as job progress.

    They are print-heavy by design (they were written as CLI tools), which makes
    this the cheapest possible progress log. Process-global, so like
    gis_workspace it is only safe at concurrency 1; uvicorn logs to stderr and
    is unaffected. Use tail_log() to bound what reaches the database.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        yield buffer


def tail_log(buffer: io.StringIO, limit: int = 8192) -> str:
    """Last `limit` characters of a capture buffer, cut at a line boundary."""
    text = buffer.getvalue()
    if len(text) <= limit:
        return text
    clipped = text[-limit:]
    newline = clipped.find("\n")
    if newline != -1:
        clipped = clipped[newline + 1 :]
    return "…\n" + clipped


# ---------------------------------------------------------------------------
# Preflight budget guards
# ---------------------------------------------------------------------------
# The input file is never the dominant allocation; the intermediate arrays are.
# Both checks below read only a header, so they cost microseconds and run before
# anything is allocated.
def check_raster_budget(src: Path, max_pixels: int, display_name: str | None = None) -> dict[str, Any]:
    """
    Reject a GeoTIFF whose pixel count would blow the memory budget.

    `display_name` is the filename the user uploaded: the local file is named
    deterministically by the worker, and naming that in an error is confusing.

    gis_common.render_dem_overlay does a full src.read(1), float64 casts in
    band_stats and colorize_to_rgba, and an H×W×4 RGBA array — a peak of roughly
    33 bytes per pixel. 16M pixels is therefore about 530 MB.
    """
    import rasterio

    name = display_name or src.name
    try:
        with rasterio.open(src) as ds:
            width, height, count = ds.width, ds.height, ds.count
            crs = ds.crs
    except GisInputError:
        raise
    except Exception as exc:
        raise GisInputError(
            "unreadable", f"{name} could not be opened as a GeoTIFF: {exc}"
        ) from exc

    if crs is None:
        raise GisInputError(
            "no_crs",
            f"{name} carries no CRS, so it cannot be placed on a map. Re-export it with "
            "one, e.g. gdal_edit.py -a_srs EPSG:32635 file.tif",
        )

    pixels = width * height
    if pixels > max_pixels:
        raise GisInputError(
            "raster_too_large",
            f"{name} is {width}x{height} = {pixels:,} pixels, over the {max_pixels:,} "
            f"pixel budget. Downsample it first, e.g. "
            f"gdal_translate -outsize {_shrink_percent(pixels, max_pixels)}% "
            f"{_shrink_percent(pixels, max_pixels)}% in.tif out.tif",
        )
    return {"width": width, "height": height, "band_count": count, "src_crs": str(crs)}


def _shrink_percent(pixels: int, max_pixels: int) -> int:
    """A suggested --outsize percentage that lands under the budget."""
    ratio = math.sqrt(max_pixels / pixels)
    return max(1, int(ratio * 100 * 0.95))


def check_lidar_budget(
    src: Path, cell: float, max_cells: int, display_name: str | None = None
) -> dict[str, Any]:
    """
    Reject a LAS/LAZ whose grid would blow the memory budget.

    process_lidar.rasterize_laz allocates nrows*ncols*8 bytes up front, sized
    from the header bounds and the cell size — before a single point is read.
    The existing chunk_iterator bounds *point* memory but does nothing about the
    grid, so a county tile at cell=0.5 is trivially tens of gigabytes.
    """
    import laspy

    name = display_name or src.name
    try:
        with laspy.open(src) as reader:
            header = reader.header
            xmin, ymin, _ = header.mins
            xmax, ymax, _ = header.maxs
            point_count = header.point_count
    except GisInputError:
        raise
    except Exception as exc:
        raise GisInputError(
            "unreadable", f"{name} could not be read as a LAS/LAZ point cloud: {exc}"
        ) from exc

    ncols = max(1, int(math.ceil((xmax - xmin) / cell)))
    nrows = max(1, int(math.ceil((ymax - ymin) / cell)))
    cells = ncols * nrows

    if cells > max_cells:
        # Same arithmetic rasterize_laz will do, solved for the cell size that
        # lands just under the budget.
        span_x = max(xmax - xmin, 1e-9)
        span_y = max(ymax - ymin, 1e-9)
        min_cell = math.sqrt(span_x * span_y / max_cells)
        min_cell = math.ceil(min_cell * 10) / 10  # round up to 0.1 m
        raise GisInputError(
            "lidar_grid_too_large",
            f"{name} at {cell} m cells needs a {ncols:,}x{nrows:,} = {cells:,} cell grid, "
            f"over the {max_cells:,} cell budget. Retry with a cell size of at least "
            f"{min_cell:g} m.",
        )
    return {"cols": ncols, "rows": nrows, "cells": cells, "point_count": int(point_count)}


def check_disk(root: Path, needed: int) -> None:
    """Fail fast rather than a third of the way through a warp."""
    try:
        free = shutil.disk_usage(root).free
    except OSError:
        return
    if free < needed:
        raise GisInputError(
            "disk_full",
            f"Not enough scratch space: {needed // MB} MB needed, {free // MB} MB free.",
        )


# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------
def r2_head(key: str) -> dict[str, Any] | None:
    """HEAD one object; None when it does not exist."""
    from botocore.exceptions import ClientError

    from deps import BUCKET, r2_client

    try:
        return r2_client.head_object(Bucket=BUCKET, Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def r2_download(key: str, dst: Path) -> int:
    from deps import BUCKET, r2_client

    dst.parent.mkdir(parents=True, exist_ok=True)
    r2_client.download_file(BUCKET, key, str(dst))
    return dst.stat().st_size


_CONTENT_TYPES = {
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".geojson": "application/geo+json",
    ".json": "application/json",
}


def r2_upload(src: Path, key: str) -> int:
    """Upload one artifact, with an explicit ContentType so the browser can use it."""
    from deps import BUCKET, r2_client

    content_type = _CONTENT_TYPES.get(src.suffix.lower(), "application/octet-stream")
    r2_client.upload_file(str(src), BUCKET, key, ExtraArgs={"ContentType": content_type})
    return src.stat().st_size


def r2_list_prefix(prefix: str) -> list[str]:
    from deps import BUCKET, r2_client

    keys: list[str] = []
    paginator = r2_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
    return keys


def r2_delete_keys(keys: list[str]) -> int:
    """Delete specific keys. Best-effort: never let cleanup fail a request."""
    from deps import BUCKET, r2_client

    deleted = 0
    for start in range(0, len(keys), 1000):
        batch = keys[start : start + 1000]
        try:
            response = r2_client.delete_objects(
                Bucket=BUCKET,
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )
            deleted += len(batch) - len(response.get("Errors", []))
        except Exception:
            logger.warning("Failed deleting %d R2 objects", len(batch), exc_info=True)
    return deleted


def r2_delete_prefix(prefix: str) -> int:
    keys = r2_list_prefix(prefix)
    return r2_delete_keys(keys) if keys else 0


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str, limit: int = 32) -> str:
    slug = _SLUG_RE.sub("_", (value or "").lower()).strip("_")
    return (slug[:limit].strip("_")) or "layer"


def match_extension(filename: str, extensions: list[str]) -> str | None:
    """
    Longest suffix wins, so `valencia.osm.pbf` matches `.osm.pbf` and not `.pbf`.
    Mirrors the frontend's matchExtension so both reject the same names.
    """
    lower = filename.lower()
    for extension in sorted(extensions, key=len, reverse=True):
        if lower.endswith(extension.lower()):
            return extension
    return None
