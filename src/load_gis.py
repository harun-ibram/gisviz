#!/usr/bin/env python3
"""
load_gis.py — Step 2 (GIS Processing): run the processors and load into PostGIS.

The bridge from Step 2 (processing) back to Step 1 (PostGIS + FastAPI). It:

  1. ensures the schema exists (scripts/gis/bootstrap.sql)
  2. runs the raster / LiDAR processors to produce web overlays + bounds, and
     upserts each as a row in public.raster_layers
  3. optionally upserts the cleaned ro.json boundaries into osm.nodes

Once loaded, the FastAPI backend can expose these via a `/raster_layers`
endpoint (returning overlay_path + ST_AsGeoJSON(bounds)) exactly the way it
serves nodes/regions today, and the React map places each PNG overlay on the
map by its WGS84 bounds. See the docstring at the bottom for the endpoint stub.

Connects using DB_URL from the repo-root .env — the same database the backend
reads from. Bring the DB up first (e.g. `docker-compose up`).

Usage:
    python load_gis.py --all                 # raster + lidar + boundaries
    python load_gis.py --raster              # just output_hh.tif
    python load_gis.py --lidar --cell 1.0
    python load_gis.py --regions
    python load_gis.py --all --dry-run       # process only, no DB writes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import gis_common as gc
import process_lidar
import process_raster

# One file builds the whole database now, so the loader applies the same thing
# a fresh instance gets rather than its own partial copy. It lives under
# scripts/gis/ with the loaders it belongs to, not next to the API.
SCHEMA_SQL = gc.REPO_ROOT / "scripts" / "gis" / "bootstrap.sql"


def ensure_schema(engine) -> None:
    ddl = SCHEMA_SQL.read_text()
    with engine.begin() as conn:
        # DDL script may contain multiple statements; exec_driver_sql runs the
        # whole batch via the raw DBAPI cursor.
        conn.exec_driver_sql(ddl)
    print(f"[load] schema ensured ({gc.rel_to_repo(SCHEMA_SQL)})")


def upsert_raster_layer(engine, layer: gc.RasterLayer) -> None:
    from sqlalchemy import text

    min_lon, min_lat, max_lon, max_lat = layer.bounds4326
    sql = text(
        """
        INSERT INTO public.raster_layers
            (id, name, kind, source, src_crs, overlay_path, geotiff_path,
             stats, properties, bounds)
        VALUES
            (:id, :name, :kind, :source, :src_crs, :overlay_path, :geotiff_path,
             CAST(:stats AS jsonb), CAST(:properties AS jsonb),
             ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326))
        ON CONFLICT (id) DO UPDATE SET
            name         = EXCLUDED.name,
            kind         = EXCLUDED.kind,
            source       = EXCLUDED.source,
            src_crs      = EXCLUDED.src_crs,
            overlay_path = EXCLUDED.overlay_path,
            geotiff_path = EXCLUDED.geotiff_path,
            stats        = EXCLUDED.stats,
            properties   = EXCLUDED.properties,
            bounds       = EXCLUDED.bounds
        """
    )
    with engine.begin() as conn:
        conn.execute(
            sql,
            {
                "id": layer.layer_id,
                "name": layer.name,
                "kind": layer.kind,
                "source": layer.source,
                "src_crs": layer.src_crs,
                "overlay_path": layer.overlay_path,
                "geotiff_path": layer.geotiff_path,
                "stats": json.dumps(layer.stats),
                "properties": json.dumps(layer.properties),
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
            },
        )
    print(f"[load] raster_layers <- {layer.layer_id}")


def upsert_regions(engine, geojson_path: Path) -> int:
    """
    Upsert cleaned boundaries (process_vectors' regions_4326.geojson) into
    osm.nodes as area nodes.

    These used to be their own table with TEXT ids. osm.nodes is keyed by
    BIGINT, so a source id like "ROSM" cannot be the primary key any more —
    each feature gets a deterministic negative id derived from that id instead,
    which keeps the upsert idempotent (re-running updates the same row rather
    than appending a duplicate) without a sequence or a lookup table.

    `source` comes from the file and is deliberately never 'drawn': that value
    is reserved for outlines a user drew, and gis_worker uses it to decide what
    is small enough to measure against LiDAR.
    """
    from sqlalchemy import text

    if not geojson_path.exists():
        print(
            f"[load] regions: {gc.rel_to_repo(geojson_path)} missing — "
            "run `python process_vectors.py --regions-only` first"
        )
        return 0

    fc = json.loads(geojson_path.read_text())
    sql = text(
        """
        INSERT INTO osm.nodes (node_id, geom, tags, source)
        VALUES (:node_id,
                ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326)),
                CAST(:tags AS jsonb),
                :source)
        ON CONFLICT (node_id) DO UPDATE SET
            geom   = EXCLUDED.geom,
            tags   = EXCLUDED.tags,
            source = EXCLUDED.source
        """
    )
    count = 0
    with engine.begin() as conn:
        for feat in fc.get("features", []):
            props = feat.get("properties", {}) or {}
            rid = props.get("id")
            if rid is None:
                continue
            # tags carries what `properties` used to, with `name` promoted to
            # the key osm.nodes.name is generated from, and the original id kept
            # so a row can still be traced back to its source feature.
            tags = dict(props)
            tags["name"] = props.get("name") or str(rid)
            tags["source_id"] = str(rid)
            conn.execute(
                sql,
                {
                    "node_id": _boundary_node_id(str(rid)),
                    "tags": json.dumps(tags),
                    "source": props.get("source") or geojson_path.name,
                    "geom": json.dumps(feat["geometry"]),
                },
            )
            count += 1
    print(f"[load] regions <- {count} area nodes")
    return count


def _boundary_node_id(source_id: str) -> int:
    """
    A stable negative node_id for an imported boundary.

    Negative because that is the space osm.nodes already reserves for
    non-OSM features (POST /nodes allocates MIN(node_id) - 1), so an import can
    never collide with a real OSM node id. Derived from the source id by hash so
    that re-importing the same file updates rather than duplicates.

    blake2b rather than hash(): PYTHONHASHSEED randomises str hashing per
    process, which would give the same boundary a different id on every run.
    """
    digest = hashlib.blake2b(source_id.encode("utf-8"), digest_size=6).digest()
    return -int.from_bytes(digest, "big") - 1


# Columns building_heights.py adds to each footprint. Kept as a tuple so the
# insert, the "did this file come from building_heights?" check and the NULL
# fallback all read from one list.
_MEASURED_FIELDS = (
    "ground_m",
    "roof_m",
    "height_m",
    "footprint_area_m2",
    "volume_prism_m3",
    "volume_lidar_m3",
)

_BUILDING_INSERT = """
    INSERT INTO public.buildings
        (id, layer_id, lidar_layer_id, osm_id, name,
         ground_m, roof_m, height_m, footprint_area_m2,
         volume_prism_m3, volume_lidar_m3, coverage, cell_count,
         properties, job_id, geom)
    VALUES
        (:id, :layer_id, :lidar_layer_id, :osm_id, :name,
         :ground_m, :roof_m, :height_m, :footprint_area_m2,
         :volume_prism_m3, :volume_lidar_m3, :coverage, :cell_count,
         CAST(:properties AS jsonb), :job_id,
         ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326)))
    ON CONFLICT (id) DO UPDATE SET
        layer_id          = EXCLUDED.layer_id,
        lidar_layer_id    = EXCLUDED.lidar_layer_id,
        osm_id            = EXCLUDED.osm_id,
        name              = EXCLUDED.name,
        ground_m          = EXCLUDED.ground_m,
        roof_m            = EXCLUDED.roof_m,
        height_m          = EXCLUDED.height_m,
        footprint_area_m2 = EXCLUDED.footprint_area_m2,
        volume_prism_m3   = EXCLUDED.volume_prism_m3,
        volume_lidar_m3   = EXCLUDED.volume_lidar_m3,
        coverage          = EXCLUDED.coverage,
        cell_count        = EXCLUDED.cell_count,
        properties        = EXCLUDED.properties,
        job_id            = EXCLUDED.job_id,
        geom              = EXCLUDED.geom
"""


def _clean_number(value) -> float | None:
    """
    GeoJSON round-trips a missing measurement as either null or NaN depending on
    the writer. Postgres REAL accepts NaN, which would then compare false against
    every threshold and sort unpredictably — normalise both to None.
    """
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _json_safe(value):
    """
    Strip non-finite floats out of a properties blob before json.dumps.

    json.dumps writes NaN/Infinity as bare tokens — valid in Python's dialect,
    not in JSON — and Postgres rejects the whole insert with
    'invalid input syntax for type json: Token "NaN" is invalid'.
    building_heights.py leaves NaN on every unmeasured building, so without this
    a single uncovered footprint fails the entire batch.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def upsert_buildings(
    engine,
    geojson_path: Path,
    layer_id: str | None = None,
    lidar_layer_id: str | None = None,
    job_id: str | None = None,
    batch_size: int = 500,
) -> int:
    """
    Upsert a building_heights.py output GeoJSON into public.buildings.

    Row ids are ``{layer_id}:{osm_id}`` so re-running the measurement over the
    same footprints updates in place instead of duplicating. Features without an
    osm_id fall back to their position in the file, which is stable for a given
    input but not across re-extracts.
    """
    from sqlalchemy import text

    if not geojson_path.exists():
        print(
            f"[load] buildings: {gc.rel_to_repo(geojson_path)} missing — "
            "run `python building_heights.py --dsm ... --dem ... --buildings ...` first"
        )
        return 0

    fc = json.loads(geojson_path.read_text())
    features = fc.get("features", [])
    if not features:
        print(f"[load] buildings: no features in {gc.rel_to_repo(geojson_path)}")
        return 0

    prefix = layer_id or geojson_path.name.split(".")[0]
    sql = text(_BUILDING_INSERT)

    rows: list[dict] = []
    skipped = 0
    for index, feat in enumerate(features):
        geometry = feat.get("geometry")
        if not geometry:
            skipped += 1
            continue

        props = feat.get("properties", {}) or {}
        osm_id = props.get("osm_id") or props.get("osm_way_id")
        try:
            osm_id = int(osm_id) if osm_id is not None else None
        except (TypeError, ValueError):
            osm_id = None

        # An explicit id wins over the derived one. Drawn target outlines need
        # this: the positional fallback below would give one a different row
        # every time the set of drawn outlines changes, so re-measuring would
        # duplicate rather than update.
        row_id = props.get("building_id")
        measured = {field: _clean_number(props.get(field)) for field in _MEASURED_FIELDS}
        rows.append(
            {
                "id": row_id or (
                    f"{prefix}:{osm_id}" if osm_id is not None else f"{prefix}:#{index}"
                ),
                "layer_id": layer_id,
                "lidar_layer_id": lidar_layer_id,
                "osm_id": osm_id,
                "name": props.get("name"),
                "coverage": _clean_number(props.get("coverage")) or 0.0,
                "cell_count": int(props.get("cell_count") or 0),
                "properties": json.dumps(_json_safe(props)),
                "job_id": job_id,
                "geom": json.dumps(geometry),
                **measured,
            }
        )

    # executemany in batches: a city extract is thousands of footprints, and one
    # round trip each over Cloud SQL turns a two-second load into minutes.
    count = 0
    with engine.begin() as conn:
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            conn.execute(sql, batch)
            count += len(batch)

    measured_count = sum(1 for row in rows if row["height_m"] is not None)
    print(
        f"[load] buildings <- {count} features "
        f"({measured_count} with a height, {count - measured_count} without)"
    )
    if skipped:
        print(f"[load] buildings: skipped {skipped} feature(s) with no geometry")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process GIS inputs and load them into PostGIS.")
    parser.add_argument("--all", action="store_true", help="raster + lidar + boundaries")
    parser.add_argument("--raster", action="store_true", help="process + load output_hh.tif")
    parser.add_argument("--lidar", action="store_true", help="process + load the .laz DEM")
    parser.add_argument("--regions", action="store_true", help="load cleaned ro.json boundaries as area nodes")
    parser.add_argument("--cell", type=float, default=1.0, help="LiDAR grid cell size in metres")
    # Not covered by --all: it needs a path, since the measured file is named
    # after whichever extract it came from rather than being a fixed fixture.
    parser.add_argument("--buildings", metavar="GEOJSON", default=None,
                        help="load a building_heights.py output into public.buildings")
    parser.add_argument("--buildings-layer-id", default=None,
                        help="vector_layers.id the footprints came from (also the row-id prefix)")
    parser.add_argument("--buildings-lidar-id", default=None,
                        help="raster_layers.id of the DSM the heights were measured against")
    parser.add_argument("--dry-run", action="store_true", help="process only; skip all DB writes")
    args = parser.parse_args(argv)

    do_raster = args.raster or args.all
    do_lidar = args.lidar or args.all
    do_regions = args.regions or args.all
    do_buildings = args.buildings is not None
    if not (do_raster or do_lidar or do_regions or do_buildings):
        parser.error("nothing to do — pass --all, --raster, --lidar, --regions and/or --buildings")

    # --- Step 2: process (no DB needed) -----------------------------------
    layers: list[gc.RasterLayer] = []
    if do_raster:
        if gc.RASTER_INPUT.exists():
            layers.append(
                process_raster.process_raster(
                    gc.RASTER_INPUT, "dem_output_hh", "Bucharest DEM (output_hh)", "dem"
                )
            )
        else:
            print(f"[load] raster skipped — {gc.rel_to_repo(gc.RASTER_INPUT)} not found")
    if do_lidar:
        if gc.LIDAR_INPUT.exists():
            layers.append(
                process_lidar.process_lidar(
                    gc.LIDAR_INPUT,
                    "dem_lidar_pa",
                    "USGS LiDAR DEM (PA 17-County)",
                    "dem",
                    args.cell,
                )
            )
        else:
            print(f"[load] lidar skipped — {gc.rel_to_repo(gc.LIDAR_INPUT)} not found")

    if args.dry_run:
        print("[load] --dry-run: processed artifacts written; no database changes made.")
        return 0

    # --- Step 1: load into PostGIS ----------------------------------------
    try:
        engine = gc.get_engine()
        with engine.connect():
            pass
    except Exception as exc:  # noqa: BLE001 — surface any connection problem plainly
        print(f"error: could not connect to the database via DB_URL: {exc}", file=sys.stderr)
        print("Is PostGIS up? For the local instance: docker-compose up", file=sys.stderr)
        return 2

    ensure_schema(engine)
    for layer in layers:
        upsert_raster_layer(engine, layer)
    if do_regions:
        upsert_regions(engine, gc.OUTPUT_DIR / "regions_4326.geojson")
    if do_buildings:
        upsert_buildings(
            engine,
            Path(args.buildings),
            layer_id=args.buildings_layer_id,
            lidar_layer_id=args.buildings_lidar_id,
        )

    print("[load] done.")
    return 0


# ---------------------------------------------------------------------------
# FastAPI endpoint stub (add to src/server on the backend_cloudflare branch)
# ---------------------------------------------------------------------------
# models.py:
#
#     class RasterLayer(SQLModel, table=True):
#         __tablename__ = "raster_layers"
#         __table_args__ = {"schema": "public"}
#         id: str = Field(primary_key=True)
#         name: str
#         kind: str = Field(default="dem")
#         source: str | None = None
#         src_crs: str | None = None
#         overlay_path: str
#         geotiff_path: str | None = None
#         stats: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB, ...))
#         properties: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB, ...))
#         bounds: Any = Field(sa_column=Column(GeometryType("Polygon", 4326), nullable=False))
#
# main.py:
#
#     @app.get("/raster_layers")
#     async def get_raster_layers(session: SessionDep):
#         rows = session.exec(
#             select(RasterLayer, func.ST_AsGeoJSON(RasterLayer.bounds))
#         ).all()
#         out = []
#         for obj, geojson in rows:
#             data = obj.model_dump(exclude="bounds")
#             data["bounds"] = json.loads(geojson) if geojson else None
#             out.append(data)
#         return out
#
# The React map then draws each overlay_path PNG within its bounds polygon.
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    raise SystemExit(main())
