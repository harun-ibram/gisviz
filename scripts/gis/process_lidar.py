#!/usr/bin/env python3
"""
process_lidar.py — Step 2 (GIS Processing): LiDAR point cloud → DEM → overlay.

Rasterizes a USGS LiDAR tile (by default public/USGS_LPC_PA_17County_...laz,
~17M points in NAD83(2011) / UTM 18N, EPSG:6347) into a gridded elevation
raster, then hands that raster to the same reproject-and-colorize pipeline the
GeoTIFF path uses. The result is a DEM (bare-earth, ground returns) or DSM
(top surface, highest return per cell) GeoTIFF plus a web PNG overlay + bounds.

  1. bin points onto a regular grid in the cloud's native metric CRS
  2. write that grid as a GeoTIFF (native CRS)                (data_output/gis/*.tif)
  3. reproject -> EPSG:4326 + colorized PNG overlay + sidecar (public/overlays/*.png)

Tools exercised: Rasterio (grid I/O), PyProj (CRS), laspy (LAS/LAZ reader).
Note: laspy/lazrs are beyond the four libraries the PDF names for Step 2, but
LiDAR is the natural raw source for the DEM/DSM that Rasterio is meant to
consume, so it's wired in here to complete the picture.

Usage:
    python process_lidar.py                      # ground DEM at 1 m cells
    python process_lidar.py --kind dsm --cell 0.5
    python process_lidar.py path/to/tile.laz --id pa_tile
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

import gis_common as gc

# LAS classification 2 == bare-earth ground (ASPRS standard).
GROUND_CLASS = 2


def _horizontal_crs(header) -> str:
    """
    Return an authority string (e.g. "EPSG:6347") for the cloud's horizontal
    CRS. USGS tiles carry a compound (horizontal + vertical) CRS; rasterio wants
    the 2D horizontal part only.
    """
    try:
        crs = header.parse_crs()
    except Exception:
        crs = None
    if crs is None:
        raise ValueError("LAS file has no CRS; cannot georeference the DEM.")

    horizontal = crs
    if crs.is_compound and crs.sub_crs_list:
        horizontal = crs.sub_crs_list[0]
    auth = horizontal.to_authority()
    if auth:
        return f"{auth[0]}:{auth[1]}"
    return horizontal.to_wkt()


def rasterize_laz(
    src_path: Path,
    cell: float,
    kind: str,
    native_tif: Path,
) -> dict:
    """
    Bin LAS points onto a `cell`-metre grid and write a native-CRS GeoTIFF.

    kind == 'dem': keep only ground-classified points, take the MIN z per cell.
    kind == 'dsm': keep all points, take the MAX z per cell.
    Empty cells are written as nodata.
    """
    import laspy
    import rasterio
    from rasterio.transform import from_origin

    with laspy.open(src_path) as reader:
        header = reader.header
        src_crs = _horizontal_crs(header)
        xmin, ymin, _ = header.mins
        xmax, ymax, _ = header.maxs

        ncols = max(1, int(np.ceil((xmax - xmin) / cell)))
        nrows = max(1, int(np.ceil((ymax - ymin) / cell)))
        print(f"[lidar] {header.point_count:,} pts, CRS {src_crs}")
        print(f"[lidar] grid {ncols}x{nrows} @ {cell} m  ({kind})")

        # Accumulator seeded so np.minimum / np.maximum fold correctly.
        fill = np.inf if kind == "dem" else -np.inf
        grid = np.full((nrows, ncols), fill, dtype="float64")

        kept = 0
        for pts in reader.chunk_iterator(2_000_000):
            x = np.asarray(pts.x)
            y = np.asarray(pts.y)
            z = np.asarray(pts.z, dtype="float64")

            if kind == "dem":
                mask = np.asarray(pts.classification) == GROUND_CLASS
                if not mask.any():
                    continue
                x, y, z = x[mask], y[mask], z[mask]

            # Column from x (west->east), row from y (north->south, row 0 = top).
            col = np.clip(((x - xmin) / cell).astype("int64"), 0, ncols - 1)
            row = np.clip(((ymax - y) / cell).astype("int64"), 0, nrows - 1)
            flat = row * ncols + col

            if kind == "dem":
                np.minimum.at(grid.reshape(-1), flat, z)
            else:
                np.maximum.at(grid.reshape(-1), flat, z)
            kept += z.size

    if kind == "dem" and kept == 0:
        raise ValueError(
            "No ground-classified (class 2) points found; re-run with --kind dsm "
            "to grid the top surface instead."
        )

    nodata = -9999.0
    grid[~np.isfinite(grid)] = nodata
    grid = grid.astype("float32")

    transform = from_origin(xmin, ymax, cell, cell)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "height": nrows,
        "width": ncols,
        "crs": src_crs,
        "transform": transform,
        "nodata": nodata,
        "compress": "lzw",
    }
    native_tif.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(native_tif, "w", **profile) as dst:
        dst.write(grid, 1)

    filled = int((grid != nodata).sum())
    print(f"[lidar] gridded {kept:,} pts into {filled:,}/{nrows * ncols:,} cells")
    return {"src_crs": src_crs, "kept": kept}


def process_lidar(
    src_path: Path,
    layer_id: str,
    name: str,
    kind: str,
    cell: float,
) -> gc.RasterLayer:
    gc.ensure_dirs()

    native_tif = gc.OUTPUT_DIR / f"{layer_id}_native.tif"
    geotiff_out = gc.OUTPUT_DIR / f"{layer_id}_4326.tif"
    png_out = gc.OVERLAY_DIR / f"{layer_id}.png"
    sidecar_out = gc.OUTPUT_DIR / f"{layer_id}.json"

    print(f"[lidar] reading   {gc.rel_to_repo(src_path)}")
    rasterized = rasterize_laz(src_path, cell, kind, native_tif)

    meta = gc.reproject_geotiff_to_wgs84(native_tif, geotiff_out)
    print(f"[lidar] warped -> EPSG:4326  {meta['width']}x{meta['height']}px")
    print(f"[lidar] bounds    {meta['bounds4326']}")

    stats = gc.render_dem_overlay(geotiff_out, png_out)
    print(
        f"[lidar] elevation min={stats['min']:.2f} max={stats['max']:.2f} "
        f"mean={stats['mean']:.2f} (n={stats['count']})"
    )

    layer = gc.RasterLayer(
        layer_id=layer_id,
        name=name,
        kind=kind,
        source=src_path.name,
        src_crs=meta["src_crs"],
        bounds4326=meta["bounds4326"],
        overlay_path=gc.overlay_web_path(png_out),
        geotiff_path=gc.rel_to_repo(geotiff_out),
        stats=stats,
        properties={
            "nodata": meta["nodata"],
            "cell_size_m": cell,
            "points_used": rasterized["kept"],
            "native_geotiff": gc.rel_to_repo(native_tif),
        },
    )
    layer.write_sidecar(sidecar_out)

    print(f"[lidar] geotiff   {gc.rel_to_repo(geotiff_out)}")
    print(f"[lidar] overlay   {gc.rel_to_repo(png_out)}  (web: {layer.overlay_path})")
    print(f"[lidar] sidecar   {gc.rel_to_repo(sidecar_out)}")
    return layer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rasterize a LiDAR .laz/.las tile into a DEM/DSM overlay.")
    parser.add_argument(
        "input",
        nargs="?",
        default=str(gc.LIDAR_INPUT),
        help="input .laz/.las (default: public/USGS_LPC_PA_...laz)",
    )
    parser.add_argument("--id", dest="layer_id", default=None, help="layer id (default: derived from filename)")
    parser.add_argument("--name", default=None, help="human-readable layer name")
    parser.add_argument("--kind", default="dem", choices=["dem", "dsm"], help="dem=ground min, dsm=surface max")
    parser.add_argument("--cell", type=float, default=1.0, help="grid cell size in metres (default: 1.0)")
    args = parser.parse_args(argv)

    src_path = Path(args.input)
    if not src_path.exists():
        print(f"error: input point cloud not found: {src_path}", file=sys.stderr)
        return 1

    layer_id = args.layer_id or f"{args.kind}_lidar_{src_path.stem[:16].lower()}"
    name = args.name or f"LiDAR {args.kind.upper()} ({src_path.stem})"
    process_lidar(src_path, layer_id, name, args.kind, args.cell)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
