#!/usr/bin/env python3
"""
process_raster.py — Step 2 (GIS Processing): raster / DEM → web overlay.

Takes a GeoTIFF (by default public/output_hh.tif, a single-band float32
elevation raster covering the Bucharest map area) and produces the artifacts
the app needs to show it on the map:

  1. a reprojected GeoTIFF in EPSG:4326                (data_output/gis/*.tif)
  2. a colorized RGBA PNG overlay                      (public/overlays/*.png)
  3. a metadata sidecar: WGS84 bounds + elevation stats (data_output/gis/*.json)

The PNG + bounds are what load_gis.py inserts into public.raster_layers and
what the frontend places on the map as an image overlay. Reprojection is done
with GDAL/rasterio; CRS handling is pyproj under the hood.

Tools exercised: GDAL (via rasterio), Rasterio, PyProj.

Usage:
    python process_raster.py                       # public/output_hh.tif
    python process_raster.py path/to/dem.tif
    python process_raster.py dem.tif --id my_dem --name "My DEM" --kind dsm
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import gis_common as gc


def process_raster(
    src_path: Path,
    layer_id: str,
    name: str,
    kind: str,
) -> gc.RasterLayer:
    gc.ensure_dirs()

    stem = layer_id
    geotiff_out = gc.OUTPUT_DIR / f"{stem}_4326.tif"
    png_out = gc.OVERLAY_DIR / f"{stem}.png"
    sidecar_out = gc.OUTPUT_DIR / f"{stem}.json"

    print(f"[raster] reading   {gc.rel_to_repo(src_path)}")
    meta = gc.reproject_geotiff_to_wgs84(src_path, geotiff_out)
    print(f"[raster] src CRS   {meta['src_crs']}")
    print(f"[raster] warped -> EPSG:4326  {meta['width']}x{meta['height']}px")
    print(f"[raster] bounds    {meta['bounds4326']}")

    stats = gc.render_dem_overlay(geotiff_out, png_out)
    print(
        f"[raster] elevation min={stats['min']:.2f} max={stats['max']:.2f} "
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
        properties={"nodata": meta["nodata"], "band_count": meta["count"]},
    )
    layer.write_sidecar(sidecar_out)

    print(f"[raster] geotiff   {gc.rel_to_repo(geotiff_out)}")
    print(f"[raster] overlay   {gc.rel_to_repo(png_out)}  (web: {layer.overlay_path})")
    print(f"[raster] sidecar   {gc.rel_to_repo(sidecar_out)}")
    return layer


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process a GeoTIFF/DEM into a web overlay.")
    parser.add_argument(
        "input",
        nargs="?",
        default=str(gc.RASTER_INPUT),
        help="input GeoTIFF (default: public/output_hh.tif)",
    )
    parser.add_argument("--id", dest="layer_id", default=None, help="layer id (default: input stem)")
    parser.add_argument("--name", default=None, help="human-readable layer name")
    parser.add_argument("--kind", default="dem", choices=["dem", "dsm", "raster"], help="layer kind")
    args = parser.parse_args(argv)

    src_path = Path(args.input)
    if not src_path.exists():
        print(f"error: input raster not found: {src_path}", file=sys.stderr)
        return 1

    layer_id = args.layer_id or f"dem_{src_path.stem}"
    name = args.name or src_path.stem
    process_raster(src_path, layer_id, name, args.kind)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
