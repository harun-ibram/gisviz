#!/usr/bin/env python3
"""
process_vectors.py — Step 2 (GIS Processing): vector data → clean WGS84 GeoJSON.

Handles the two vector sources in the repo with GeoPandas + PyProj:

  * public/ro.json  — Romanian county/admin polygons (GeoJSON FeatureCollection)
  * data/map.osm    — an OSM XML extract of the Bucharest map area

For each it loads the features, ensures/aligns the CRS to EPSG:4326, repairs
invalid geometry, drops empties, and writes a cleaned GeoJSON plus a small
summary (feature count + total bounds). From map.osm it splits out two useful
layers — building footprints (polygons) and roads (lines).

The cleaned outputs land in data_output/gis/. regions_4326.geojson is what
load_gis.py upserts into public.regions; the OSM building/road GeoJSON are
inspection/overlay exports (the full OSM graph itself is loaded separately by
scripts/load_data.py into the osm.* tables).

Tools exercised: GeoPandas, PyProj (via .to_crs), Shapely (geometry repair).

Usage:
    python process_vectors.py                 # both regions + OSM
    python process_vectors.py --regions-only
    python process_vectors.py --osm-only
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

import gis_common as gc

# Reading OSM XML through GDAL is fine but chatty; silence the routine notices.
warnings.filterwarnings("ignore", message=".*Sequential read.*")


def _clean(gdf):
    """Reproject to WGS84, repair invalid geometry, drop empty/null rows."""
    import geopandas as gpd
    from shapely import make_valid

    if gdf.crs is None:
        # GeoJSON/OSM without a declared CRS is WGS84 by spec.
        gdf = gdf.set_crs(gc.WGS84)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(gc.WGS84)  # pyproj-backed reprojection

    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(make_valid)
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    return gpd.GeoDataFrame(gdf, geometry="geometry", crs=gc.WGS84)


def _write(gdf, out_path: Path, label: str) -> dict:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out_path, driver="GeoJSON")
    bounds = [float(v) for v in gdf.total_bounds] if len(gdf) else []
    print(f"[vector] {label}: {len(gdf)} features -> {gc.rel_to_repo(out_path)}")
    if bounds:
        print(f"[vector] {label}: bounds {bounds}")
    return {"count": int(len(gdf)), "bounds4326": bounds, "path": gc.rel_to_repo(out_path)}


def process_regions() -> dict:
    import geopandas as gpd

    if not gc.REGIONS_INPUT.exists():
        print(f"[vector] regions: skipped, {gc.rel_to_repo(gc.REGIONS_INPUT)} not found")
        return {}

    print(f"[vector] reading  {gc.rel_to_repo(gc.REGIONS_INPUT)}")
    gdf = _clean(gpd.read_file(gc.REGIONS_INPUT))
    # A label/anchor point per region — handy for map markers; representative_point
    # stays inside the polygon and avoids the geographic-centroid warning.
    gdf["label_lon"] = gdf.geometry.representative_point().x
    gdf["label_lat"] = gdf.geometry.representative_point().y
    return _write(gdf, gc.OUTPUT_DIR / "regions_4326.geojson", "regions")


def process_osm() -> dict:
    import geopandas as gpd

    if not gc.OSM_INPUT.exists():
        print(f"[vector] osm: skipped, {gc.rel_to_repo(gc.OSM_INPUT)} not found")
        return {}

    print(f"[vector] reading  {gc.rel_to_repo(gc.OSM_INPUT)}")
    gc.ensure_dirs()
    summary: dict = {}

    # Buildings: polygon features carrying a `building` tag.
    polys = gpd.read_file(gc.OSM_INPUT, layer="multipolygons")
    buildings = _clean(polys[polys["building"].notna()])
    summary["buildings"] = _write(
        buildings, gc.OUTPUT_DIR / "osm_buildings_4326.geojson", "buildings"
    )

    # Roads: line features carrying a `highway` tag.
    lines = gpd.read_file(gc.OSM_INPUT, layer="lines")
    roads = _clean(lines[lines["highway"].notna()])
    summary["roads"] = _write(roads, gc.OUTPUT_DIR / "osm_roads_4326.geojson", "roads")

    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process ro.json + map.osm into clean WGS84 GeoJSON.")
    parser.add_argument("--regions-only", action="store_true", help="process only ro.json")
    parser.add_argument("--osm-only", action="store_true", help="process only map.osm")
    args = parser.parse_args(argv)

    if args.regions_only and args.osm_only:
        print("error: pass at most one of --regions-only / --osm-only", file=sys.stderr)
        return 1

    gc.ensure_dirs()
    if not args.osm_only:
        process_regions()
    if not args.regions_only:
        process_osm()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
