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
