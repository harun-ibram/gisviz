#!/usr/bin/env python3
"""
load_gis.py — Step 2 (GIS Processing): run the processors and load into PostGIS.

The bridge from Step 2 (processing) back to Step 1 (PostGIS + FastAPI). It:

  1. ensures the raster_layers schema exists (scripts/gis/schema_gis.sql)
  2. runs the raster / LiDAR processors to produce web overlays + bounds, and
     upserts each as a row in public.raster_layers
  3. optionally upserts the cleaned ro.json regions into public.regions

Once loaded, the FastAPI backend can expose these via a `/raster_layers`
endpoint (returning overlay_path + ST_AsGeoJSON(bounds)) exactly the way it
serves nodes/regions today, and the React map places each PNG overlay on the
map by its WGS84 bounds. See the docstring at the bottom for the endpoint stub.

Connects using DB_URL from the repo-root .env — the same database the backend
reads from. Bring the DB up first (e.g. `docker-compose up`).

Usage:
    python load_gis.py --all                 # raster + lidar + regions
    python load_gis.py --raster              # just output_hh.tif
    python load_gis.py --lidar --cell 1.0
    python load_gis.py --regions
    python load_gis.py --all --dry-run       # process only, no DB writes
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import gis_common as gc
import process_lidar
import process_raster

SCHEMA_SQL = Path(__file__).with_name("schema_gis.sql")


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
    Upsert cleaned regions (from process_vectors' regions_4326.geojson) into
    public.regions. Polygons are wrapped to MultiPolygon to match the column.
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
        INSERT INTO public.regions (id, name, source, properties, geom)
        VALUES (:id, :name, :source, CAST(:properties AS jsonb),
                ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326)))
        ON CONFLICT (id) DO UPDATE SET
            name       = EXCLUDED.name,
            source     = EXCLUDED.source,
            properties = EXCLUDED.properties,
            geom       = EXCLUDED.geom
        """
    )
    count = 0
    with engine.begin() as conn:
        for feat in fc.get("features", []):
            props = feat.get("properties", {}) or {}
            rid = props.get("id")
            if rid is None:
                continue
            conn.execute(
                sql,
                {
                    "id": str(rid),
                    "name": props.get("name") or str(rid),
                    "source": props.get("source"),
                    "properties": json.dumps(props),
                    "geom": json.dumps(feat["geometry"]),
                },
            )
            count += 1
    print(f"[load] regions <- {count} features")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Process GIS inputs and load them into PostGIS.")
    parser.add_argument("--all", action="store_true", help="raster + lidar + regions")
    parser.add_argument("--raster", action="store_true", help="process + load output_hh.tif")
    parser.add_argument("--lidar", action="store_true", help="process + load the .laz DEM")
    parser.add_argument("--regions", action="store_true", help="load cleaned ro.json regions")
    parser.add_argument("--cell", type=float, default=1.0, help="LiDAR grid cell size in metres")
    parser.add_argument("--dry-run", action="store_true", help="process only; skip all DB writes")
    args = parser.parse_args(argv)

    do_raster = args.raster or args.all
    do_lidar = args.lidar or args.all
    do_regions = args.regions or args.all
    if not (do_raster or do_lidar or do_regions):
        parser.error("nothing to do — pass --all, --raster, --lidar and/or --regions")

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
