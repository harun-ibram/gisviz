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
    python process_vectors.py                 # both defaults: ro.json + map.osm
    python process_vectors.py --regions-only
    python process_vectors.py --osm-only
    python process_vectors.py my_regions.geojson   # any GeoPandas-readable vector
    python process_vectors.py extra.osm            # auto-detected as OSM
    python process_vectors.py boundaries.shp --as regions
    python process_vectors.py city.osm.pbf --bbox -0.42 39.44 -0.31 39.50  # clip at read time
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


def _native_bbox(bbox4326, src: Path, layer: str | None = None):
    """
    Turn a WGS84 (lon/lat) bbox into the source's native CRS for read-time
    clipping. `--bbox` is always given in lon/lat (like every output here); if
    the source is in another CRS (e.g. a projected shapefile) the four corners
    are reprojected and their envelope is used. Returns an (xmin, ymin, xmax,
    ymax) tuple pyogrio can filter on, or None when no bbox was requested.
    """
    if bbox4326 is None:
        return None

    import pyogrio
    from pyproj import CRS, Transformer

    try:
        info = pyogrio.read_info(src, layer=layer) if layer else pyogrio.read_info(src)
        crs_str = info.get("crs")
    except Exception:
        crs_str = None

    if crs_str:
        crs = CRS.from_user_input(crs_str)
        if crs.to_epsg() not in (4326, None):
            transformer = Transformer.from_crs(4326, crs, always_xy=True)
            min_lon, min_lat, max_lon, max_lat = bbox4326
            xs, ys = [], []
            for lon in (min_lon, max_lon):
                for lat in (min_lat, max_lat):
                    x, y = transformer.transform(lon, lat)
                    xs.append(x)
                    ys.append(y)
            return (min(xs), min(ys), max(xs), max(ys))

    return tuple(bbox4326)


def _write(gdf, out_path: Path, label: str) -> dict:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out_path, driver="GeoJSON")
    bounds = [float(v) for v in gdf.total_bounds] if len(gdf) else []
    print(f"[vector] {label}: {len(gdf)} features -> {gc.rel_to_repo(out_path)}")
    if bounds:
        print(f"[vector] {label}: bounds {bounds}")
    return {"count": int(len(gdf)), "bounds4326": bounds, "path": gc.rel_to_repo(out_path)}


def process_regions(src: Path = gc.REGIONS_INPUT, bbox=None) -> dict:
    """Clean + reproject any GeoPandas-readable vector (GeoJSON/Shapefile/GPKG)."""
    import geopandas as gpd

    if not src.exists():
        print(f"[vector] regions: skipped, {gc.rel_to_repo(src)} not found")
        return {}

    print(f"[vector] reading  {gc.rel_to_repo(src)}")
    gc.ensure_dirs()
    gdf = _clean(gpd.read_file(src, bbox=_native_bbox(bbox, src)))
    # A label/anchor point per feature — handy for map markers; representative_point
    # stays on the geometry and avoids the geographic-centroid warning.
    gdf["label_lon"] = gdf.geometry.representative_point().x
    gdf["label_lat"] = gdf.geometry.representative_point().y

    # Keep the stable name for the well-known regions input (load_gis.py reads it);
    # derive from the stem for any custom file.
    stem = "regions" if src == gc.REGIONS_INPUT else src.stem
    return _write(gdf, gc.OUTPUT_DIR / f"{stem}_4326.geojson", "regions")


def process_osm(src: Path = gc.OSM_INPUT, bbox=None) -> dict:
    import geopandas as gpd

    if not src.exists():
        print(f"[vector] osm: skipped, {gc.rel_to_repo(src)} not found")
        return {}

    print(f"[vector] reading  {gc.rel_to_repo(src)}")
    gc.ensure_dirs()
    summary: dict = {}

    # Keep the "osm_" prefix for the well-known map.osm; otherwise use the file's
    # base name, stripping the compound OSM suffix (foo.osm.pbf -> foo, since
    # Path.stem only removes the final ".pbf" and would leave a trailing ".osm").
    if src == gc.OSM_INPUT:
        prefix = "osm"
    else:
        prefix = src.stem
        if prefix.endswith(".osm"):
            prefix = prefix[: -len(".osm")]

    # Push the tag filters into the OGR read (`where=`) instead of reading the
    # whole layer and filtering in pandas. On a city-sized .osm.pbf the full
    # multipolygons/lines layers are millions of features — materialising them
    # exhausts memory and looks like a hang (and the C read can't be Ctrl-C'd).
    # Filtering at read time keeps only buildings/roads, so a 138 MB Valencia
    # extract loads in seconds.

    # Buildings: polygon features carrying a `building` tag.
    buildings = _clean(
        gpd.read_file(
            src,
            layer="multipolygons",
            where="building IS NOT NULL",
            bbox=_native_bbox(bbox, src, "multipolygons"),
        )
    )
    summary["buildings"] = _write(
        buildings, gc.OUTPUT_DIR / f"{prefix}_buildings_4326.geojson", "buildings"
    )

    # Roads: line features carrying a `highway` tag.
    roads = _clean(
        gpd.read_file(
            src,
            layer="lines",
            where="highway IS NOT NULL",
            bbox=_native_bbox(bbox, src, "lines"),
        )
    )
    summary["roads"] = _write(roads, gc.OUTPUT_DIR / f"{prefix}_roads_4326.geojson", "roads")

    return summary


# Extensions handled by GDAL's OSM driver (multipolygons/lines layers).
_OSM_SUFFIXES = {".osm", ".pbf", ".xml"}


def _detect_type(path: Path) -> str:
    """'osm' for OSM XML/PBF inputs, else 'regions' (generic vector)."""
    return "osm" if path.suffix.lower() in _OSM_SUFFIXES else "regions"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process vector data into clean WGS84 GeoJSON.")
    parser.add_argument(
        "input",
        nargs="?",
        default=None,
        help="a vector file to process (default: both public/ro.json + data/map.osm)",
    )
    parser.add_argument(
        "--as",
        dest="as_type",
        choices=["regions", "osm"],
        default=None,
        help="override how INPUT is handled (default: auto-detect by extension)",
    )
    parser.add_argument("--regions-only", action="store_true", help="process only ro.json (no INPUT)")
    parser.add_argument("--osm-only", action="store_true", help="process only map.osm (no INPUT)")
    parser.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("MIN_LON", "MIN_LAT", "MAX_LON", "MAX_LAT"),
        default=None,
        help="clip to this WGS84 lon/lat box at read time (e.g. --bbox -0.42 39.44 -0.31 39.50)",
    )
    args = parser.parse_args(argv)

    bbox = args.bbox
    if bbox is not None:
        min_lon, min_lat, max_lon, max_lat = bbox
        if min_lon >= max_lon or min_lat >= max_lat:
            print("error: --bbox must be MIN_LON MIN_LAT MAX_LON MAX_LAT with min < max", file=sys.stderr)
            return 1

    gc.ensure_dirs()

    # Single-file mode: process just the given file, typed by --as or extension.
    if args.input is not None:
        if args.regions_only or args.osm_only:
            print("error: --regions-only / --osm-only don't apply when a file is given", file=sys.stderr)
            return 1

        src = Path(args.input)
        if not src.exists():
            print(f"error: input vector file not found: {src}", file=sys.stderr)
            return 1

        kind = args.as_type or _detect_type(src)
        if kind == "osm":
            process_osm(src, bbox=bbox)
        else:
            process_regions(src, bbox=bbox)
        return 0

    # Default mode: the two well-known inputs.
    if args.regions_only and args.osm_only:
        print("error: pass at most one of --regions-only / --osm-only", file=sys.stderr)
        return 1
    if not args.osm_only:
        process_regions(bbox=bbox)
    if not args.regions_only:
        process_osm(bbox=bbox)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
