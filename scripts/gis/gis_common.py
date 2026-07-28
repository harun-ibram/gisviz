"""
Shared helpers for the GISViz "Step 2 — GIS Processing" pipeline.

This module is the common ground for the raster / LiDAR / vector processing
scripts (``process_raster.py``, ``process_lidar.py``, ``process_vectors.py``)
and the database loader (``load_gis.py``). It centralises three concerns:

  * paths        — where the raw inputs live and where processed artifacts go
  * reprojection — everything the frontend map expects is EPSG:4326 (WGS84
                   lon/lat), so any raster/vector coming in on another CRS is
                   warped here via GDAL/rasterio + pyproj
  * web overlays — browsers cannot render a raw GeoTIFF, so a raster/DEM is
                   turned into a colorized RGBA PNG plus its WGS84 bounds; the
                   frontend positions that PNG on the map like an image overlay
                   (the same role model_path/R2 plays for splats)

None of the processing functions here touch the database — they only read the
raw files and write derived files. The DB engine helper is provided for
``load_gis.py`` alone, and is imported lazily so the processing scripts can run
with no database available.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# scripts/gis/gis_common.py -> repo root is two parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]

# Raw inputs currently live in public/ (moved there so the dev server can also
# serve the originals if needed). Adjust here if they move.
PUBLIC_DIR = REPO_ROOT / "public"
DATA_DIR = REPO_ROOT / "data"

# Processed, reprojected artifacts (GeoTIFF / GeoJSON / stats sidecars).
OUTPUT_DIR = REPO_ROOT / "data_output" / "gis"

# Web-ready PNG overlays. Kept under public/ so Vite serves them statically at
# /overlays/<name>.png; the loader records this relative path. If you later push
# overlays to R2 instead, upload from here and store the R2 key the same way
# model_path is stored for splats.
OVERLAY_DIR = PUBLIC_DIR / "overlays"

# Well-known input files (all optional — each script checks existence).
RASTER_INPUT = PUBLIC_DIR / "output_hh.tif"
LIDAR_INPUT = PUBLIC_DIR / "USGS_LPC_PA_17County_D24_18STK297416.laz"
REGIONS_INPUT = PUBLIC_DIR / "ro.json"
OSM_INPUT = DATA_DIR / "map.osm"

WGS84 = "EPSG:4326"


def ensure_dirs() -> None:
    """Create the output directories if they do not exist yet."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OVERLAY_DIR.mkdir(parents=True, exist_ok=True)


def rel_to_repo(path: Path) -> str:
    """Path relative to the repo root, POSIX-style (for logging / sidecars)."""
    return path.resolve().relative_to(REPO_ROOT).as_posix()


def overlay_web_path(png_path: Path) -> str:
    """
    The URL path the frontend uses to fetch an overlay served from public/.
    public/overlays/dem_foo.png  ->  /overlays/dem_foo.png
    """
    return "/" + png_path.resolve().relative_to(PUBLIC_DIR).as_posix()


# ---------------------------------------------------------------------------
# Layer metadata — the shape a processed raster/DEM hands to the DB loader
# ---------------------------------------------------------------------------
@dataclass
class RasterLayer:
    """
    One web-ready raster overlay + its georeferencing and stats.

    ``bounds4326`` is [min_lon, min_lat, max_lon, max_lat]; the loader turns it
    into a PostGIS envelope. ``overlay_path`` is the /overlays/... web path.
    """

    layer_id: str
    name: str
    kind: str  # 'dem' | 'dsm' | 'raster'
    source: str  # where the data came from (filename / provider)
    src_crs: str  # native CRS of the input, e.g. "EPSG:6347"
    bounds4326: list[float]
    overlay_path: str
    geotiff_path: str
    stats: dict[str, float] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def write_sidecar(self, path: Path) -> None:
        path.write_text(json.dumps(self.to_dict(), indent=2))


# ---------------------------------------------------------------------------
# Reprojection (GDAL/rasterio + pyproj)
# ---------------------------------------------------------------------------
def reproject_geotiff_to_wgs84(src_path: Path, dst_path: Path) -> dict[str, Any]:
    """
    Warp a single-band raster to EPSG:4326 and write it as a GeoTIFF.

    Returns a metadata dict: source CRS, WGS84 bounds, shape, nodata. This is
    the GDAL-backed reprojection step (rasterio wraps GDAL; the CRS math is
    pyproj under the hood). If the raster is already WGS84 it is still copied
    through so downstream steps have a single, uniform product to read.
    """
    import rasterio
    from rasterio.warp import calculate_default_transform, reproject, Resampling

    with rasterio.open(src_path) as src:
        src_crs = src.crs
        if src_crs is None:
            raise ValueError(
                f"{src_path} has no CRS; cannot reproject. Assign one first "
                "(e.g. with gdal_edit) or set it in the calling script."
            )

        transform, width, height = calculate_default_transform(
            src_crs, WGS84, src.width, src.height, *src.bounds
        )
        profile = src.profile.copy()
        profile.update(
            crs=WGS84,
            transform=transform,
            width=width,
            height=height,
            driver="GTiff",
            compress="lzw",
        )

        dst_path.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(dst_path, "w", **profile) as dst:
            for band in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band),
                    destination=rasterio.band(dst, band),
                    src_transform=src.transform,
                    src_crs=src_crs,
                    dst_transform=transform,
                    dst_crs=WGS84,
                    resampling=Resampling.bilinear,
                )

        with rasterio.open(dst_path) as dst:
            b = dst.bounds
            return {
                "src_crs": str(src_crs),
                "bounds4326": [b.left, b.bottom, b.right, b.top],
                "width": dst.width,
                "height": dst.height,
                "nodata": dst.nodata,
                "count": dst.count,
            }


# ---------------------------------------------------------------------------
# Elevation statistics
# ---------------------------------------------------------------------------
def band_stats(array: np.ndarray, nodata: float | None) -> dict[str, float]:
    """min / max / mean / p2 / p98 over valid (non-nodata, finite) pixels."""
    data = np.asarray(array, dtype="float64")
    mask = np.isfinite(data)
    if nodata is not None:
        mask &= data != nodata
    valid = data[mask]
    if valid.size == 0:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "p2": 0.0, "p98": 0.0, "count": 0}
    return {
        "min": float(valid.min()),
        "max": float(valid.max()),
        "mean": float(valid.mean()),
        "p2": float(np.percentile(valid, 2)),
        "p98": float(np.percentile(valid, 98)),
        "count": int(valid.size),
    }


# ---------------------------------------------------------------------------
# Colorization -> RGBA PNG overlay
# ---------------------------------------------------------------------------
# Compact "terrain" ramp (low -> high elevation): deep green, green, khaki,
# brown, white. Interpolated to a 256-entry LUT at import time. Kept inline so
# the pipeline needs no matplotlib.
_TERRAIN_STOPS = np.array(
    [
        [0.00, 46, 89, 64],     # low  — dark green
        [0.30, 122, 158, 74],   # green
        [0.55, 205, 197, 128],  # khaki
        [0.78, 150, 110, 78],   # brown
        [1.00, 245, 245, 245],  # high — near white
    ]
)


def _build_lut() -> np.ndarray:
    xs = np.linspace(0.0, 1.0, 256)
    stops = _TERRAIN_STOPS
    lut = np.empty((256, 3), dtype="uint8")
    for channel in range(3):
        lut[:, channel] = np.interp(xs, stops[:, 0], stops[:, channel + 1]).astype("uint8")
    return lut


_TERRAIN_LUT = _build_lut()


def colorize_to_rgba(
    array: np.ndarray,
    nodata: float | None,
    vmin: float | None = None,
    vmax: float | None = None,
) -> np.ndarray:
    """
    Map a single-band float raster to an (H, W, 4) uint8 RGBA image using the
    terrain LUT. Values are normalised to [vmin, vmax] (defaults to the 2nd/98th
    percentiles so a few outliers don't wash out the ramp). Nodata / non-finite
    pixels become fully transparent.
    """
    data = np.asarray(array, dtype="float64")
    valid = np.isfinite(data)
    if nodata is not None:
        valid &= data != nodata

    if vmin is None or vmax is None:
        stats = band_stats(data, nodata)
        vmin = stats["p2"] if vmin is None else vmin
        vmax = stats["p98"] if vmax is None else vmax
    if vmax <= vmin:
        vmax = vmin + 1.0

    norm = np.clip((data - vmin) / (vmax - vmin), 0.0, 1.0)
    idx = (norm * 255).astype("uint8")

    rgba = np.zeros((data.shape[0], data.shape[1], 4), dtype="uint8")
    rgba[..., :3] = _TERRAIN_LUT[idx]
    rgba[..., 3] = np.where(valid, 255, 0).astype("uint8")
    return rgba


def write_png(rgba: np.ndarray, dst_path: Path) -> None:
    """Write an (H, W, 4) uint8 array as an RGBA PNG."""
    from PIL import Image

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(dst_path, format="PNG")


def render_dem_overlay(
    geotiff_wgs84: Path,
    png_path: Path,
    vmin: float | None = None,
    vmax: float | None = None,
) -> dict[str, float]:
    """
    Read a WGS84 GeoTIFF (band 1), colorize it and write the PNG overlay.
    Returns the band statistics (also used to fill RasterLayer.stats).
    """
    import rasterio

    with rasterio.open(geotiff_wgs84) as src:
        band = src.read(1)
        nodata = src.nodata

    stats = band_stats(band, nodata)
    rgba = colorize_to_rgba(band, nodata, vmin, vmax)
    write_png(rgba, png_path)
    return stats


# ---------------------------------------------------------------------------
# Database engine (used only by load_gis.py)
# ---------------------------------------------------------------------------
def get_engine():
    """
    SQLAlchemy engine built from DB_URL in the repo-root .env — the same
    connection string the FastAPI backend (src/server/database.py) uses, so the
    loader writes to exactly the database the API reads from.
    """
    from dotenv import load_dotenv
    from sqlalchemy import create_engine

    load_dotenv(REPO_ROOT / ".env")
    db_url = os.environ.get("DB_URL")
    if not db_url:
        raise RuntimeError("DB_URL is not set in .env — cannot connect to PostGIS.")
    return create_engine(db_url, pool_pre_ping=True)
