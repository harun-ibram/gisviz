"""
GIS schema bootstrap, applied at app startup.

Mirrors schema_gis.sql (in this same directory), but as a *list of single statements*:
load_gis.ensure_schema hands the whole file to conn.exec_driver_sql(), which
works on psycopg but not on pg8000 — its extended query protocol cannot run
several ';'-separated statements in one call, and that is what the server uses.
Every statement here is idempotent, so a redeploy re-runs them harmlessly.
"""

from __future__ import annotations

import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)


DDL_STATEMENTS: list[str] = [
    "CREATE EXTENSION IF NOT EXISTS postgis",
    # ---- 1. raster_layers (tiff + lidar) --------------------------------
    # The table itself predates this pipeline (schema_gis.sql);
    # create it if the CLI loader never ran against this database.
    """
    CREATE TABLE IF NOT EXISTS public.raster_layers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'dem'
                     CHECK (kind IN ('dem', 'dsm', 'raster')),
        source       TEXT,
        src_crs      TEXT,
        overlay_path TEXT NOT NULL,
        geotiff_path TEXT,
        stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
        properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
        bounds       GEOMETRY(Polygon, 4326) NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_raster_layers_bounds ON public.raster_layers USING GIST (bounds)",
    # overlay_path/geotiff_path now hold an R2 key for server-produced rows, the
    # way osm.nodes.model_path does for splats. `storage` disambiguates the
    # legacy '/overlays/x.png' rows the CLI loader wrote.
    "ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS layer_type TEXT NOT NULL DEFAULT 'tiff'",
    "ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS storage    TEXT NOT NULL DEFAULT 'r2'",
    "ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS job_id     TEXT",
    "ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
    "UPDATE public.raster_layers SET storage='static'   WHERE overlay_path LIKE '/%'     AND storage    <> 'static'",
    "UPDATE public.raster_layers SET layer_type='lidar' WHERE properties ? 'cell_size_m' AND layer_type <> 'lidar'",
    "CREATE INDEX IF NOT EXISTS idx_raster_layers_job     ON public.raster_layers (job_id)",
    "CREATE INDEX IF NOT EXISTS idx_raster_layers_created ON public.raster_layers (created_at DESC)",
    # ---- 2. vector_layers (osm + geojson) -------------------------------
    # Features live in R2 as a GeoJSON object; this row is metadata + envelope.
    """
    CREATE TABLE IF NOT EXISTS public.vector_layers (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        layer_type    TEXT NOT NULL CHECK (layer_type IN ('osm','geojson')),
        sublayer      TEXT NOT NULL DEFAULT 'features'
                      CHECK (sublayer IN ('buildings','roads','features')),
        source        TEXT,
        src_crs       TEXT,
        geojson_key   TEXT NOT NULL,
        feature_count INTEGER NOT NULL DEFAULT 0,
        size_bytes    BIGINT,
        properties    JSONB NOT NULL DEFAULT '{}'::jsonb,
        bounds        GEOMETRY(Polygon, 4326),
        job_id        TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_vector_layers_bounds ON public.vector_layers USING GIST (bounds)",
    "CREATE INDEX IF NOT EXISTS idx_vector_layers_job    ON public.vector_layers (job_id)",
    "CREATE INDEX IF NOT EXISTS idx_vector_layers_type   ON public.vector_layers (layer_type, sublayer)",
    # ---- 3. gis_jobs ----------------------------------------------------
    # Separate from public.jobs, whose target_type/target_id are NOT NULL and
    # meaningless here, whose status vocabulary lacks 'queued', and which
    # carries a modal_call_id no GIS job will ever have.
    """
    CREATE TABLE IF NOT EXISTS public.gis_jobs (
        id            TEXT PRIMARY KEY,
        layer_type    TEXT NOT NULL CHECK (layer_type IN ('tiff','osm','geojson','lidar')),
        name          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'awaiting_upload'
                      CHECK (status IN ('awaiting_upload','queued','running','done','failed','cancelled')),
        step          TEXT,
        input_prefix  TEXT NOT NULL,
        input_files   JSONB NOT NULL DEFAULT '[]'::jsonb,
        options       JSONB NOT NULL DEFAULT '{}'::jsonb,
        layer_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
        output_prefix TEXT,
        error         TEXT,
        error_kind    TEXT,
        log           TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at    TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_gis_jobs_status  ON public.gis_jobs (status)",
    "CREATE INDEX IF NOT EXISTS idx_gis_jobs_created ON public.gis_jobs (created_at DESC)",
    # ---- 4. discovery view ----------------------------------------------
    # DROP+CREATE rather than CREATE OR REPLACE: the pre-existing view has a
    # different column list, and CREATE OR REPLACE VIEW may only append columns.
    # Nothing reads this — the API queries both tables directly — but it keeps
    # "what layers exist?" answerable from psql.
    "DROP VIEW IF EXISTS public.gis_layers",
    """
    CREATE VIEW public.gis_layers AS
    SELECT 'raster'::text AS geometry_class, r.layer_type, r.id AS layer_id, r.name, r.kind,
           NULL::text AS sublayer, r.overlay_path AS asset_key, r.bounds AS geom,
           r.stats || r.properties AS properties, r.job_id, r.created_at
    FROM public.raster_layers r
    UNION ALL
    SELECT 'vector'::text, v.layer_type, v.id, v.name, NULL::text, v.sublayer,
           v.geojson_key, v.bounds, v.properties, v.job_id, v.created_at
    FROM public.vector_layers v
    """,
    # ---- 5. buildings ---------------------------------------------------
    # One row per OSM footprint, carrying the height/volume building_heights.py
    # derived from a LiDAR DSM/DEM pair. Unlike vector_layers (whose features
    # live in R2 as one GeoJSON blob) these are queried individually — the map
    # asks for "buildings in this bbox" and extrudes each by height_m.
    #
    # The measurements are NULLABLE on purpose: a footprint outside the LiDAR
    # tile or under dense canopy has no usable height, and NULL renders as "no
    # data" where 0 would draw a confident, wrong, flat box.
    """
    CREATE TABLE IF NOT EXISTS public.buildings (
        id                TEXT PRIMARY KEY,
        layer_id          TEXT,
        lidar_layer_id    TEXT,
        osm_id            BIGINT,
        name              TEXT,
        ground_m          REAL,
        roof_m            REAL,
        height_m          REAL,
        footprint_area_m2 REAL,
        volume_prism_m3   REAL,
        volume_lidar_m3   REAL,
        coverage          REAL NOT NULL DEFAULT 0,
        cell_count        INTEGER NOT NULL DEFAULT 0,
        properties        JSONB NOT NULL DEFAULT '{}'::jsonb,
        job_id            TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        geom              GEOMETRY(MultiPolygon, 4326) NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_buildings_geom  ON public.buildings USING GIST (geom)",
    "CREATE INDEX IF NOT EXISTS idx_buildings_layer ON public.buildings (layer_id)",
    "CREATE INDEX IF NOT EXISTS idx_buildings_job   ON public.buildings (job_id)",
    # ---- 6. splat pipeline: SuGaR mesh stage -----------------------------
    # public.jobs itself is created by scripts/gis/schema.sql, not here — this
    # only adds what the mesh stage introduced, so a deployed database picks the
    # columns up on the next boot instead of needing a hand-run ALTER. Mirrors
    # the Job / OSMNode / Region models in src/models.py.
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS want_mesh         BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS work_prefix       TEXT",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS mesh_key          TEXT",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS mesh_status       TEXT",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS mesh_error        TEXT",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS mesh_call_id      TEXT",
    "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS inputs_deleted_at TIMESTAMPTZ",
    "ALTER TABLE osm.nodes      ADD COLUMN IF NOT EXISTS mesh_path  TEXT",
    "ALTER TABLE public.regions ADD COLUMN IF NOT EXISTS mesh_path  TEXT",
    # model_path was on the Region model but never in regions' CREATE TABLE.
    "ALTER TABLE public.regions ADD COLUMN IF NOT EXISTS model_path TEXT",
    # ---- 7. drawn footprints ---------------------------------------------
    # The outline a user draws when creating a target. Regions already have a
    # MultiPolygon `geom` to hold one; nodes do not and cannot — osm.nodes.geom
    # is a Point that osm.build_way_geometry() feeds to ST_MakeLine — so they
    # get a separate nullable column and keep the point as ST_PointOnSurface of
    # the outline. Mirrors the OSMNode model in src/models.py.
    "ALTER TABLE osm.nodes ADD COLUMN IF NOT EXISTS footprint GEOMETRY(MultiPolygon, 4326)",
    "CREATE INDEX IF NOT EXISTS idx_nodes_footprint ON osm.nodes USING GIST (footprint)",
    # A database built from an older scripts/gis/schema.sql may still have this
    # NOT NULL. Dropping it on an already-nullable column is a no-op, not an error.
    "ALTER TABLE public.regions ALTER COLUMN geom DROP NOT NULL",
]


def ensure_gis_schema(engine) -> None:
    """
    Apply DDL_STATEMENTS one statement per round trip (pg8000 cannot batch).

    Each statement gets its own transaction so one failure — say an ALTER a
    restricted role is not allowed to run — does not roll back the rest.
    """
    applied = 0
    for statement in DDL_STATEMENTS:
        sql = statement.strip()
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
            applied += 1
        except Exception:
            logger.warning("GIS schema statement failed: %s", sql.split("\n")[0][:120], exc_info=True)
    logger.info("GIS schema: %d/%d statements applied", applied, len(DDL_STATEMENTS))


def reap_orphaned_gis_jobs(engine) -> int:
    """
    Fail jobs left mid-flight by a restart.

    Railway kills in-flight BackgroundTasks on redeploy, so anything still
    queued/running when the process died would otherwise poll forever.
    """
    sql = text(
        """
        UPDATE public.gis_jobs
        SET status      = 'failed',
            error_kind  = 'worker_restart',
            error       = COALESCE(error, 'The worker restarted before this job finished.'),
            finished_at = now(),
            updated_at  = now()
        WHERE status IN ('queued', 'running')
        """
    )
    with engine.begin() as conn:
        result = conn.execute(sql)
    count = result.rowcount or 0
    if count:
        logger.warning("Reaped %d orphaned GIS job(s) left by a restart", count)
    return count
