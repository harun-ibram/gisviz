-- ============================================================================
-- GISViz — Step 2 (GIS Processing) schema additions
-- Additive to init-scripts/schema.sql; safe to run repeatedly (IF NOT EXISTS).
--
-- Adds raster/DEM overlay layers to the map. A raster can't be rendered in the
-- browser directly, so each row stores a web-ready PNG overlay path plus the
-- WGS84 envelope the frontend uses to position it — the raster analogue of how
-- osm.nodes.model_path points splats at their R2 files.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS public.raster_layers (
    id           TEXT PRIMARY KEY,                    -- e.g. "dem_output_hh"
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'dem'          -- dem | dsm | raster
                 CHECK (kind IN ('dem', 'dsm', 'raster')),
    source       TEXT,                                -- originating file / provider
    src_crs      TEXT,                                -- native CRS before warping, e.g. "EPSG:6347"
    overlay_path TEXT NOT NULL,                       -- "/overlays/xxx.png" (static) or R2 key
    geotiff_path TEXT,                                -- reprojected GeoTIFF (data_output/gis/...)
    stats        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- min/max/mean/percentile elevation
    properties   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- nodata, cell size, band count, ...
    bounds       GEOMETRY(Polygon, 4326) NOT NULL     -- WGS84 envelope for map placement
);

CREATE INDEX IF NOT EXISTS idx_raster_layers_bounds ON public.raster_layers USING GIST (bounds);

-- Unified feature view extended with raster layers, so a single query can
-- discover every map layer. Rasters expose their bounding box as geometry;
-- the overlay image itself is fetched separately via overlay_path.
CREATE OR REPLACE VIEW public.gis_layers AS
SELECT 'raster'::text        AS layer_type,
       id                    AS layer_id,
       name,
       kind,
       overlay_path,
       bounds                AS geom,
       stats || properties   AS properties
FROM public.raster_layers;

-- ============================================================================
-- Upload pipeline additions (src/gis_api.py, src/gis_worker.py)
--
-- The server applies these same statements from src/gis_schema.py at startup,
-- one statement per round trip: it talks to Cloud SQL over pg8000, whose
-- extended query protocol cannot run several ';'-separated statements in one
-- call the way load_gis.ensure_schema's exec_driver_sql(whole_file) does here.
-- Keep the two in sync — this file is the CLI loader's copy.
-- ============================================================================

-- 1. Extend raster_layers (tiff + lidar). overlay_path/geotiff_path now hold an
--    R2 key for server-produced rows, as osm.nodes.model_path does for splats.
--    `storage` disambiguates legacy '/overlays/x.png' rows written by this loader.
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS layer_type TEXT NOT NULL DEFAULT 'tiff';
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS storage    TEXT NOT NULL DEFAULT 'r2';
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS job_id     TEXT;
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.raster_layers SET storage='static'   WHERE overlay_path LIKE '/%'     AND storage    <> 'static';
UPDATE public.raster_layers SET layer_type='lidar' WHERE properties ? 'cell_size_m' AND layer_type <> 'lidar';

CREATE INDEX IF NOT EXISTS idx_raster_layers_job     ON public.raster_layers (job_id);
CREATE INDEX IF NOT EXISTS idx_raster_layers_created ON public.raster_layers (created_at DESC);

-- 2. Vector results (osm + geojson). The features live in R2 as a GeoJSON
--    object; this row is metadata + the envelope used to place/cull the layer.
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
);

CREATE INDEX IF NOT EXISTS idx_vector_layers_bounds ON public.vector_layers USING GIST (bounds);
CREATE INDEX IF NOT EXISTS idx_vector_layers_job    ON public.vector_layers (job_id);
CREATE INDEX IF NOT EXISTS idx_vector_layers_type   ON public.vector_layers (layer_type, sublayer);

-- 3. GIS jobs. Separate from public.jobs, whose target_type/target_id are NOT
--    NULL and meaningless here, whose status vocabulary lacks 'queued', and
--    which carries a modal_call_id no GIS job will ever have.
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
);

CREATE INDEX IF NOT EXISTS idx_gis_jobs_status  ON public.gis_jobs (status);
CREATE INDEX IF NOT EXISTS idx_gis_jobs_created ON public.gis_jobs (created_at DESC);

-- 4. Discovery view, replacing the raster-only one above. DROP+CREATE rather
--    than CREATE OR REPLACE: the column list changes, and CREATE OR REPLACE
--    VIEW may only append columns. Nothing reads it — the API queries both
--    tables directly — but it keeps "what layers exist?" answerable from psql.
DROP VIEW IF EXISTS public.gis_layers;
CREATE VIEW public.gis_layers AS
SELECT 'raster'::text AS geometry_class, r.layer_type, r.id AS layer_id, r.name, r.kind,
       NULL::text AS sublayer, r.overlay_path AS asset_key, r.bounds AS geom,
       r.stats || r.properties AS properties, r.job_id, r.created_at
FROM public.raster_layers r
UNION ALL
SELECT 'vector'::text, v.layer_type, v.id, v.name, NULL::text, v.sublayer,
       v.geojson_key, v.bounds, v.properties, v.job_id, v.created_at
FROM public.vector_layers v;
