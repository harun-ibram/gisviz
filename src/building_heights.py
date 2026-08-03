#!/usr/bin/env python3
"""
building_heights.py — Step 2 (GIS Processing): LiDAR + footprints → building
heights and volumes.

Takes the two rasters `process_lidar.py` already produces from a single tile and
the building footprints `process_vectors.py` extracts from OSM, and derives a
height and a volume for every footprint:

    DSM (top surface, --kind dsm)  ─┐
    DEM (bare earth, --kind dem)   ─┼─→  height_m, volume_m3 per building
    building footprints (GeoJSON)  ─┘

The point clouds are never rendered as buildings — they are a *measurement*
source. What ends up on the map is the OSM footprint polygon, extruded by the
number derived here.

Ground and roof are read as percentiles, not min/max: chimneys, antennas and
parapets wreck a MAX, and a single stray low return wrecks a MIN.

All zonal maths happens in the raster's **native (metric) CRS** — the
`*_native.tif` that process_lidar.py writes, not the `*_4326.tif`. Areas and
volumes computed in degrees are meaningless, so passing a geographic raster is
rejected outright. Only the output geometry is written back in WGS84, matching
every other artifact in this pipeline.

Tools exercised: Rasterio (windowed reads + geometry masks), GeoPandas/Shapely
(reprojection, buffering), NumPy (percentiles).

Usage:
    # both rasters must come from the same tile at the same --cell
    python process_lidar.py tile.laz --kind dsm --cell 1.0 --id t_dsm
    python process_lidar.py tile.laz --kind dem --cell 1.0 --id t_dem
    python process_vectors.py city.osm.pbf --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT

    python building_heights.py \\
        --dsm data_output/gis/t_dsm_native.tif \\
        --dem data_output/gis/t_dem_native.tif \\
        --buildings data_output/gis/city_buildings_4326.geojson
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import gis_common as gc

# Ground is sampled from a ring *outside* the footprint: the DEM directly under a
# building is interpolated from whatever ground returns squeezed past the walls,
# so it is the least trustworthy part of the surface.
DEFAULT_RING_M = 2.0

# 10th percentile of the ring resists a sloping site and stray vegetation lows;
# 75th of the roof resists chimneys/antennas while still reaching the main roof
# plane rather than the eaves.
DEFAULT_GROUND_PERCENTILE = 10.0
DEFAULT_ROOF_PERCENTILE = 75.0

# Footprints whose sampled cells are mostly nodata produce a confident-looking
# but meaningless height. Below this fraction the row is written with a null
# height so downstream can render it differently instead of drawing a 0 m box.
MIN_COVERAGE = 0.30

# Reading both grids whole is far faster than thousands of windowed disk reads,
# and a 1 km tile at 1 m cells is only ~1.25M cells. Guard the pathological case.
MAX_GRID_CELLS = 120_000_000


def _display(path: Path) -> str:
    """
    Repo-relative path for logs and sidecars, absolute when it lives elsewhere.

    The other processors only ever name files they created under data_output/,
    so gc.rel_to_repo is always safe for them. This one takes arbitrary --dsm /
    --dem / --buildings paths — a tile sitting on another drive is perfectly
    normal — and gc.rel_to_repo raises ValueError on anything outside the repo.
    """
    try:
        return gc.rel_to_repo(path)
    except ValueError:
        return str(path.resolve())


def _open_grid(path: Path, label: str) -> dict:
    """
    Read a single-band elevation grid whole, with its georeferencing.

    Rejects geographic CRSs: this module multiplies cell counts by cell area to
    get m², which is only meaningful when the CRS units are metres.
    """
    import rasterio

    if not path.exists():
        raise FileNotFoundError(f"{label} raster not found: {path}")

    with rasterio.open(path) as src:
        if src.crs is None:
            raise ValueError(f"{label} raster {path} has no CRS; cannot measure against it.")
        if src.crs.is_geographic:
            raise ValueError(
                f"{label} raster {path} is in a geographic CRS ({src.crs}). Areas and "
                "volumes would come out in degrees. Pass the *_native.tif that "
                "process_lidar.py writes, not the *_4326.tif."
            )
        if src.width * src.height > MAX_GRID_CELLS:
            raise ValueError(
                f"{label} raster is {src.width}x{src.height} cells, over the "
                f"{MAX_GRID_CELLS:,} guard. Re-grid with a coarser --cell."
            )

        data = src.read(1).astype("float64")
        nodata = src.nodata

        # process_lidar.py writes -9999.0 for empty cells; normalise every flavour
        # of "no data" to NaN so the percentile maths has one thing to skip.
        invalid = ~np.isfinite(data)
        if nodata is not None:
            invalid |= data == nodata
        data[invalid] = np.nan

        return {
            "data": data,
            "transform": src.transform,
            "crs": src.crs,
            "width": src.width,
            "height": src.height,
            "path": path,
        }


def _check_aligned(dsm: dict, dem: dict) -> None:
    """
    Both grids must describe the same cells. process_lidar.py derives the grid
    from the LAS header bounds and --cell, so the same tile at the same --cell
    lines up exactly — but a mismatched pair would silently subtract unrelated
    ground from unrelated roofs, so it is checked rather than assumed.
    """
    if dsm["crs"] != dem["crs"]:
        raise ValueError(f"DSM CRS {dsm['crs']} != DEM CRS {dem['crs']}; re-grid from one tile.")
    if (dsm["width"], dsm["height"]) != (dem["width"], dem["height"]):
        raise ValueError(
            f"DSM is {dsm['width']}x{dsm['height']} but DEM is {dem['width']}x{dem['height']}; "
            "re-run process_lidar.py with the same --cell for both."
        )
    if not np.allclose(np.array(dsm["transform"]), np.array(dem["transform"]), atol=1e-6):
        raise ValueError("DSM and DEM grids are offset from each other; re-grid from one tile.")


def _window_slice(bounds, transform, width: int, height: int) -> tuple[slice, slice] | None:
    """
    Pixel slices covering `bounds` (in raster CRS), clipped to the raster.
    Returns None when the geometry falls entirely outside the tile.
    """
    from rasterio.windows import from_bounds

    window = from_bounds(*bounds, transform=transform)
    row_start = max(0, int(np.floor(window.row_off)))
    col_start = max(0, int(np.floor(window.col_off)))
    row_stop = min(height, int(np.ceil(window.row_off + window.height)))
    col_stop = min(width, int(np.ceil(window.col_off + window.width)))

    if row_start >= row_stop or col_start >= col_stop:
        return None
    return slice(row_start, row_stop), slice(col_start, col_stop)


def _mask_for(geom, rows: slice, cols: slice, transform, all_touched: bool) -> np.ndarray:
    """Boolean mask, True inside `geom`, over the given window of the grid."""
    from rasterio.features import geometry_mask
    from rasterio.windows import Window, transform as window_transform

    window = Window(cols.start, rows.start, cols.stop - cols.start, rows.stop - rows.start)
    return geometry_mask(
        [geom],
        out_shape=(window.height, window.width),
        transform=window_transform(window, transform),
        invert=True,  # True = inside the polygon
        all_touched=all_touched,
    )


def _unmeasured(area: float | None, coverage: float = 0.0, cells: int = 0) -> dict:
    """A row we could not derive a height for — null rather than a misleading 0."""
    return {
        "ground_m": None,
        "roof_m": None,
        "height_m": None,
        "footprint_area_m2": area,
        "volume_prism_m3": None,
        "volume_lidar_m3": None,
        "coverage": round(coverage, 4),
        "cell_count": cells,
    }


def measure_building(
    geom,
    dsm: dict,
    dem: dict,
    cell_area: float,
    ring_m: float,
    ground_percentile: float,
    roof_percentile: float,
) -> dict:
    """
    Height and volume for one footprint, in the rasters' native metric CRS.

    Returns a dict of measurements; `height_m` is None when the footprint has
    too few valid cells to trust (outside the tile, or under dense canopy).
    """
    area = float(geom.area)

    # The ring extends past the footprint, so the window has to cover it too.
    ringed = geom.buffer(ring_m)
    window = _window_slice(ringed.bounds, dsm["transform"], dsm["width"], dsm["height"])
    if window is None:
        return _unmeasured(area)

    rows, cols = window
    dsm_tile = dsm["data"][rows, cols]
    dem_tile = dem["data"][rows, cols]

    # all_touched=False keeps volume honest by not counting cells the footprint
    # merely clips. A building smaller than one cell would then get nothing, so
    # fall back to all_touched for those rather than dropping them.
    inside = _mask_for(geom, rows, cols, dsm["transform"], all_touched=False)
    if not inside.any():
        inside = _mask_for(geom, rows, cols, dsm["transform"], all_touched=True)
    if not inside.any():
        return _unmeasured(area)

    cells = int(inside.sum())
    roof_values = dsm_tile[inside & np.isfinite(dsm_tile)]
    coverage = float(roof_values.size) / float(cells)
    if roof_values.size == 0 or coverage < MIN_COVERAGE:
        return _unmeasured(area, coverage, cells)

    # Ring = buffered footprint minus the footprint itself.
    ring = _mask_for(ringed, rows, cols, dsm["transform"], all_touched=True) & ~inside
    ground_values = dem_tile[ring & np.isfinite(dem_tile)]
    if ground_values.size == 0:
        # No ground returns around the building (dense terrace, or tile edge) —
        # fall back to the bare earth beneath it, which is interpolated but is
        # still a better datum than nothing.
        ground_values = dem_tile[inside & np.isfinite(dem_tile)]
    if ground_values.size == 0:
        return _unmeasured(area, coverage, cells)

    ground = float(np.percentile(ground_values, ground_percentile))
    roof = float(np.percentile(roof_values, roof_percentile))
    height = max(roof - ground, 0.0)

    # True volume under the roof surface: every cell contributes its own height,
    # so pitched and stepped roofs are integrated rather than averaged.
    above = np.clip(roof_values - ground, 0.0, None)
    volume_lidar = float(above.sum() * cell_area)

    return {
        "ground_m": round(ground, 3),
        "roof_m": round(roof, 3),
        "height_m": round(height, 3),
        "footprint_area_m2": round(area, 3),
        # What a flat extrusion of `height_m` would occupy. Compared against
        # volume_lidar it is a free correctness signal: the two agree on flat
        # roofs and diverge on pitched ones.
        "volume_prism_m3": round(area * height, 3),
        "volume_lidar_m3": round(volume_lidar, 3),
        "coverage": round(coverage, 4),
        "cell_count": cells,
    }


def process_buildings(
    dsm_path: Path,
    dem_path: Path,
    buildings_path: Path,
    out_path: Path,
    ring_m: float = DEFAULT_RING_M,
    ground_percentile: float = DEFAULT_GROUND_PERCENTILE,
    roof_percentile: float = DEFAULT_ROOF_PERCENTILE,
) -> dict:
    """Measure every footprint and write an annotated WGS84 GeoJSON."""
    import geopandas as gpd

    gc.ensure_dirs()

    print(f"[heights] dsm       {_display(dsm_path)}")
    print(f"[heights] dem       {_display(dem_path)}")
    dsm = _open_grid(dsm_path, "DSM")
    dem = _open_grid(dem_path, "DEM")
    _check_aligned(dsm, dem)

    cell_x = abs(dsm["transform"].a)
    cell_y = abs(dsm["transform"].e)
    cell_area = cell_x * cell_y
    print(f"[heights] grid      {dsm['width']}x{dsm['height']} @ {cell_x:g}x{cell_y:g} m  ({dsm['crs']})")

    print(f"[heights] buildings {_display(buildings_path)}")
    gdf = gpd.read_file(buildings_path)
    if gdf.crs is None:
        gdf = gdf.set_crs(gc.WGS84)
    total = len(gdf)
    if total == 0:
        raise ValueError(f"No features in {buildings_path}")

    # Footprints go to the raster, not the other way round: warping the grid
    # would resample elevations, and the whole point is to measure them.
    local = gdf.to_crs(dsm["crs"])

    records = []
    for position, geom in enumerate(local.geometry, start=1):
        if geom is None or geom.is_empty:
            records.append(_unmeasured(None))
        else:
            records.append(measure_building(
                geom, dsm, dem, cell_area, ring_m, ground_percentile, roof_percentile
            ))

        if position % 2000 == 0:
            print(f"[heights] measured {position:,}/{total:,}")

    measured = gpd.GeoDataFrame(records, index=gdf.index)
    out = gdf.join(measured)

    heights = out["height_m"].dropna()
    summary = {
        "buildings": int(total),
        "measured": int(heights.size),
        "unmeasured": int(total - heights.size),
        "height_m": {
            "min": float(heights.min()) if heights.size else 0.0,
            "median": float(heights.median()) if heights.size else 0.0,
            "max": float(heights.max()) if heights.size else 0.0,
        },
        "total_volume_lidar_m3": float(out["volume_lidar_m3"].dropna().sum()),
        "total_volume_prism_m3": float(out["volume_prism_m3"].dropna().sum()),
        "cell_size_m": [cell_x, cell_y],
        "src_crs": str(dsm["crs"]),
        "params": {
            "ring_m": ring_m,
            "ground_percentile": ground_percentile,
            "roof_percentile": roof_percentile,
            "min_coverage": MIN_COVERAGE,
        },
        "sources": {
            "dsm": _display(dsm_path),
            "dem": _display(dem_path),
            "buildings": _display(buildings_path),
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_file(out_path, driver="GeoJSON")

    sidecar = out_path.with_suffix(".json")
    sidecar.write_text(json.dumps(summary, indent=2))

    print(
        f"[heights] measured  {summary['measured']:,}/{total:,} "
        f"({summary['unmeasured']:,} without usable LiDAR cover)"
    )
    if heights.size:
        h = summary["height_m"]
        print(f"[heights] height    min={h['min']:.2f} median={h['median']:.2f} max={h['max']:.2f} m")
        print(
            f"[heights] volume    lidar={summary['total_volume_lidar_m3']:,.0f} m3  "
            f"prism={summary['total_volume_prism_m3']:,.0f} m3"
        )
    print(f"[heights] geojson   {_display(out_path)}")
    print(f"[heights] sidecar   {_display(sidecar)}")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Derive building heights and volumes from a LiDAR DSM/DEM pair."
    )
    parser.add_argument("--dsm", required=True, help="surface raster (process_lidar.py --kind dsm, *_native.tif)")
    parser.add_argument("--dem", required=True, help="ground raster (process_lidar.py --kind dem, *_native.tif)")
    parser.add_argument("--buildings", required=True, help="footprints GeoJSON from process_vectors.py")
    parser.add_argument("--out", default=None, help="output GeoJSON (default: <buildings stem>_heights.geojson)")
    parser.add_argument("--ring", type=float, default=DEFAULT_RING_M,
                        help=f"ground sampling ring width in metres (default: {DEFAULT_RING_M})")
    parser.add_argument("--ground-percentile", type=float, default=DEFAULT_GROUND_PERCENTILE,
                        help=f"percentile of ring DEM taken as ground (default: {DEFAULT_GROUND_PERCENTILE})")
    parser.add_argument("--roof-percentile", type=float, default=DEFAULT_ROOF_PERCENTILE,
                        help=f"percentile of footprint DSM taken as roof (default: {DEFAULT_ROOF_PERCENTILE})")
    args = parser.parse_args(argv)

    buildings_path = Path(args.buildings)
    if args.out:
        out_path = Path(args.out)
    else:
        stem = buildings_path.name.split(".")[0]
        out_path = gc.OUTPUT_DIR / f"{stem}_heights_4326.geojson"

    try:
        process_buildings(
            Path(args.dsm),
            Path(args.dem),
            buildings_path,
            out_path,
            ring_m=args.ring,
            ground_percentile=args.ground_percentile,
            roof_percentile=args.roof_percentile,
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
