-- ============================================================================
-- GISViz — full database bootstrap, from an empty PostgreSQL 18 + PostGIS.
--
--     psql "$DB_URL" -f scripts/gis/bootstrap.sql
--
-- Replaces the old two-file dance (scripts/gis/schema.sql then src/schema_gis.sql,
-- in that order or the ALTERs silently failed against tables that did not exist
-- yet). Everything here is idempotent, so re-running it against a live database
-- is a no-op; the app's startup DDL (src/gis_schema.py, src/auth.py) applies the
-- same objects and is likewise safe to run on top.
--
-- NODES AND REGIONS ARE ONE TABLE
-- -------------------------------
-- public.regions is gone. A region was "a named polygon you can hang a splat
-- on", which is a node with an area — so osm.nodes.geom is now
-- GEOMETRY(Geometry, 4326) constrained to a Point *or* a Polygon/MultiPolygon,
-- and the old nullable `footprint` column is gone with it. One table, one id
-- space (BIGINT, negative for user-created), one set of endpoints.
--
-- The reason `geom` was a Point in the first place is osm.build_way_geometry()
-- below, which feeds it to ST_MakeLine. That is handled by coercing with
-- ST_PointOnSurface, which returns a Point unchanged and picks an interior
-- point of an area — so a way whose vertex list somehow includes an area node
-- still builds, instead of erroring the whole load.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS osm;


-- ----------------------------------------------------------------------------
-- 1. NODES — every map target: OSM points, drawn outlines, imported boundaries
-- ----------------------------------------------------------------------------
-- `source` is what distinguishes them, and it is load-bearing rather than
-- decorative: 'drawn' is the filter that keeps the building-height measurement
-- in src/gis_worker.py from trying to rasterise an imported county at one metre.
--   NULL / 'osm'  — came from map.osm
--   'drawn'       — a user drew it in the browser (POST /nodes)
--   anything else — an import's origin, e.g. 'ro.json'
--
-- `name` is generated from tags rather than stored twice: OSM nodes carry their
-- name in tags->>'name' and regions used to carry it in a NOT NULL column, and
-- that split is exactly what this merge removes. Writers set tags; readers get
-- a real, indexable column for free.
CREATE TABLE IF NOT EXISTS osm.nodes (
    node_id     BIGINT PRIMARY KEY,
    geom        GEOMETRY(Geometry, 4326) NOT NULL,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    name        TEXT GENERATED ALWAYS AS (tags ->> 'name') STORED,
    source      TEXT,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    model_path  TEXT,                    -- R2 key of the Gaussian splat (.ply)
    mesh_path   TEXT,                    -- R2 key of the mesh (.glb) built from it
    "timestamp" TIMESTAMPTZ,
    -- Point or area, nothing else. LineString belongs to osm.ways, and a
    -- GeometryCollection would break every consumer that assumes one or the
    -- other. GeometryType() is IMMUTABLE, so it is legal in a CHECK.
    CONSTRAINT nodes_geom_kind CHECK (
        GeometryType(geom) IN ('POINT', 'POLYGON', 'MULTIPOLYGON')
    )
);

CREATE INDEX IF NOT EXISTS idx_nodes_geom ON osm.nodes USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_nodes_tags ON osm.nodes USING GIN (tags);
-- Only nodes carrying meaningful tags (POIs) — most nodes are bare way vertices
-- and do not belong in POI search.
CREATE INDEX IF NOT EXISTS idx_nodes_tagged
    ON osm.nodes ((tags != '{}'::jsonb)) WHERE tags != '{}'::jsonb;
-- "Give me the areas" / "give me the pins" is now a query on every node list,
-- since the two shapes share a table.
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON osm.nodes ((GeometryType(geom)));
-- The drawn-outline measurement scans this on every LiDAR job.
CREATE INDEX IF NOT EXISTS idx_nodes_drawn ON osm.nodes (source) WHERE source = 'drawn';
-- /splat_nodes, which is every node with a reconstruction attached.
CREATE INDEX IF NOT EXISTS idx_nodes_model ON osm.nodes (node_id) WHERE model_path IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2. WAYS — ordered sequences of nodes forming lines or polygons
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS osm.ways (
    way_id      BIGINT PRIMARY KEY,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    "timestamp" TIMESTAMPTZ,
    is_area     BOOLEAN NOT NULL DEFAULT FALSE, -- closed ring meant to render as a polygon
    geom        GEOMETRY(Geometry, 4326)        -- LineString or Polygon, built from way_nodes
);

CREATE INDEX IF NOT EXISTS idx_ways_geom ON osm.ways USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_ways_tags ON osm.ways USING GIN (tags);

-- Junction table preserving node order within a way (an OSM way is an ORDERED
-- list of node references, possibly repeating the first node to close a ring —
-- hence a surrogate PK rather than PRIMARY KEY(way_id, node_id)).
CREATE TABLE IF NOT EXISTS osm.way_nodes (
    way_id      BIGINT NOT NULL REFERENCES osm.ways(way_id) ON DELETE CASCADE,
    node_id     BIGINT NOT NULL REFERENCES osm.nodes(node_id),
    sequence_id INTEGER NOT NULL,
    PRIMARY KEY (way_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_way_nodes_node ON osm.way_nodes (node_id);


-- ----------------------------------------------------------------------------
-- 3. RELATIONS — typed, roled collections of nodes/ways/relations
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS osm.relations (
    relation_id BIGINT PRIMARY KEY,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    "timestamp" TIMESTAMPTZ,
    geom        GEOMETRY(Geometry, 4326)  -- built from members; see build_relation_geometry()
);

CREATE INDEX IF NOT EXISTS idx_relations_geom ON osm.relations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_relations_tags ON osm.relations USING GIN (tags);

CREATE TABLE IF NOT EXISTS osm.relation_members (
    relation_id BIGINT NOT NULL REFERENCES osm.relations(relation_id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('node', 'way', 'relation')),
    member_id   BIGINT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    sequence_id INTEGER NOT NULL,
    PRIMARY KEY (relation_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_relation_members_member
    ON osm.relation_members (member_type, member_id);


-- ----------------------------------------------------------------------------
-- 4. USERS — login (src/auth.py keeps an identical copy in AUTH_DDL)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ----------------------------------------------------------------------------
-- 5. JOBS — photos -> GS2Mesh on Modal -> .ply + .glb in R2, written back to
--    the node's model_path/mesh_path.
-- ----------------------------------------------------------------------------
-- `node_id` replaces the old (target_type, target_id) pair. target_type only
-- ever held 'node' or 'region', and with regions merged there is nothing left
-- to discriminate — so the column is gone and the surviving id is a real
-- BIGINT FK instead of a TEXT id that had to be cast at every use.
CREATE TABLE IF NOT EXISTS public.jobs (
    id            TEXT PRIMARY KEY,                       -- uuid
    -- Still only about the splat: 'done' means the .ply is served. The mesh
    -- stage reports separately through mesh_status.
    status        TEXT NOT NULL DEFAULT 'pending',        -- pending|processing|done|failed
    node_id       BIGINT NOT NULL REFERENCES osm.nodes(node_id) ON DELETE CASCADE,
    input_prefix  TEXT NOT NULL,                          -- R2 prefix holding uploaded photos
    output_key    TEXT,                                   -- R2 key of the produced splat
    modal_call_id TEXT,                                   -- Modal function-call id
    error         TEXT,
    -- Vestigial under GS2Mesh, which always produces both artifacts. Kept so
    -- old rows and old clients still read; nothing branches on it.
    want_mesh     BOOLEAN NOT NULL DEFAULT FALSE,
    work_prefix   TEXT,                                   -- legacy SuGaR handoff prefix
    mesh_key      TEXT,                                   -- R2 key of the produced .glb
    mesh_status   TEXT,                                   -- NULL|processing|done|failed|skipped
    mesh_error    TEXT,
    mesh_call_id  TEXT,
    inputs_deleted_at TIMESTAMPTZ,                        -- when the photos were purged
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_node   ON public.jobs (node_id);


-- ----------------------------------------------------------------------------
-- 6. RASTER LAYERS — tiff + lidar overlays (src/gis_worker.py)
-- ----------------------------------------------------------------------------
-- A raster cannot be drawn in the browser, so each row stores a web-ready PNG
-- plus the WGS84 envelope that places it — the raster analogue of how
-- osm.nodes.model_path points a node at its splat in R2.
CREATE TABLE IF NOT EXISTS public.raster_layers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'dem'
                 CHECK (kind IN ('dem', 'dsm', 'raster')),
    layer_type   TEXT NOT NULL DEFAULT 'tiff',
    -- 'static' for legacy '/overlays/x.png' rows written by the CLI loader,
    -- 'r2' for anything the upload pipeline produced.
    storage      TEXT NOT NULL DEFAULT 'r2',
    source       TEXT,
    src_crs      TEXT,
    overlay_path TEXT NOT NULL,
    geotiff_path TEXT,
    stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
    properties   JSONB NOT NULL DEFAULT '{}'::jsonb,
    bounds       GEOMETRY(Polygon, 4326) NOT NULL,
    job_id       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raster_layers_bounds  ON public.raster_layers USING GIST (bounds);
CREATE INDEX IF NOT EXISTS idx_raster_layers_job     ON public.raster_layers (job_id);
CREATE INDEX IF NOT EXISTS idx_raster_layers_created ON public.raster_layers (created_at DESC);


-- ----------------------------------------------------------------------------
-- 7. VECTOR LAYERS — osm + geojson results
-- ----------------------------------------------------------------------------
-- The features live in R2 as one GeoJSON object; this row is metadata plus the
-- envelope used to place and cull the layer.
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


-- ----------------------------------------------------------------------------
-- 8. GIS JOBS — the upload/processing pipeline's own job table
-- ----------------------------------------------------------------------------
-- Separate from public.jobs, whose node_id is NOT NULL and meaningless here,
-- whose status vocabulary lacks 'queued', and which carries a modal_call_id no
-- GIS job will ever have.
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


-- ----------------------------------------------------------------------------
-- 9. BUILDINGS — per-footprint heights from a LiDAR DSM/DEM pair
-- ----------------------------------------------------------------------------
-- Unlike vector_layers (one GeoJSON blob in R2) these are queried individually:
-- the map asks for "buildings in this bbox" and extrudes each by height_m.
--
-- The measurements are NULLABLE on purpose. A footprint outside the LiDAR tile
-- or under dense canopy has no usable height, and NULL renders as "no data"
-- where 0 would draw a confident, wrong, flat box.
CREATE TABLE IF NOT EXISTS public.buildings (
    id                TEXT PRIMARY KEY,
    layer_id          TEXT,          -- vector_layers.id the footprints came from
    lidar_layer_id    TEXT,          -- raster_layers.id of the DSM used
    osm_id            BIGINT,        -- osm.nodes.node_id or osm.ways.way_id
    name              TEXT,
    ground_m          REAL,          -- percentile of DEM in a ring outside the footprint
    roof_m            REAL,          -- percentile of DSM inside the footprint
    height_m          REAL,          -- roof - ground, NULL when uncovered
    footprint_area_m2 REAL,
    volume_prism_m3   REAL,          -- area x height (what a flat extrusion shows)
    volume_lidar_m3   REAL,          -- per-cell integral under the roof surface
    coverage          REAL NOT NULL DEFAULT 0,
    cell_count        INTEGER NOT NULL DEFAULT 0,
    properties        JSONB NOT NULL DEFAULT '{}'::jsonb,
    job_id            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom              GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buildings_geom  ON public.buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_layer ON public.buildings (layer_id);
CREATE INDEX IF NOT EXISTS idx_buildings_job   ON public.buildings (job_id);


-- ============================================================================
-- GEOMETRY-BUILDING FUNCTIONS
-- Called by the loader after bulk-inserting nodes/way_nodes/relation_members.
-- (Deliberately not triggers: recomputing geometry row-by-row during a bulk OSM
-- import would be very slow. Call these once per way/relation after load, or
-- wrap edits to a single way/relation in the app layer and re-run them.)
-- ============================================================================

-- Build (or rebuild) a way's geometry from its ordered nodes.
CREATE OR REPLACE FUNCTION osm.build_way_geometry(p_way_id BIGINT)
RETURNS VOID AS $$
DECLARE
    v_line     GEOMETRY;
    v_closed   BOOLEAN;
    v_tags     JSONB;
    v_area     BOOLEAN;
BEGIN
    -- ST_PointOnSurface, not n.geom directly: nodes may now be areas, and
    -- ST_MakeLine over a polygon errors. On a Point it returns that same point,
    -- so the ordinary OSM-vertex case is unchanged.
    SELECT ST_MakeLine(ST_PointOnSurface(n.geom) ORDER BY wn.sequence_id)
    INTO v_line
    FROM osm.way_nodes wn
    JOIN osm.nodes n ON n.node_id = wn.node_id
    WHERE wn.way_id = p_way_id;

    IF v_line IS NULL THEN
        RETURN;
    END IF;

    v_closed := COALESCE(ST_IsClosed(v_line), FALSE) AND ST_NPoints(v_line) >= 4;
    SELECT tags INTO v_tags FROM osm.ways WHERE way_id = p_way_id;

    -- area=no forces a line; a linear-only tag like highway/barrier (without
    -- area=yes) stays a line even if closed; everything else closed is a polygon
    v_area := v_closed
        AND COALESCE(v_tags->>'area', '') <> 'no'
        AND (
            v_tags->>'area' = 'yes'
            OR v_tags ?| ARRAY['building', 'landuse', 'leisure', 'natural', 'amenity', 'boundary']
            OR NOT (v_tags ? 'highway' OR v_tags ? 'barrier')
        );

    -- ST_MakePolygon can still fail on a degenerate/self-intersecting ring;
    -- fall back to the line rather than aborting the whole load.
    BEGIN
        UPDATE osm.ways
        SET is_area = v_area,
            geom    = CASE WHEN v_area THEN ST_MakePolygon(v_line) ELSE v_line END
        WHERE way_id = p_way_id;
    EXCEPTION WHEN OTHERS THEN
        UPDATE osm.ways SET is_area = FALSE, geom = v_line WHERE way_id = p_way_id;
    END;
END;
$$ LANGUAGE plpgsql;

-- Rebuild every way's geometry (initial load helper).
CREATE OR REPLACE FUNCTION osm.build_all_way_geometries()
RETURNS VOID AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT way_id FROM osm.ways LOOP
        PERFORM osm.build_way_geometry(r.way_id);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Build (or rebuild) a relation's geometry from its members.
-- Multipolygon/boundary relations: union "outer" ways into polygons and
-- subtract "inner" ways (holes). Anything else (routes, etc.): collect member
-- geometries as-is into a GeometryCollection.
CREATE OR REPLACE FUNCTION osm.build_relation_geometry(p_relation_id BIGINT)
RETURNS VOID AS $$
DECLARE
    v_type   TEXT;
    v_outer  GEOMETRY;
    v_inner  GEOMETRY;
    v_geom   GEOMETRY;
BEGIN
    SELECT tags->>'type' INTO v_type FROM osm.relations WHERE relation_id = p_relation_id;

    IF v_type IN ('multipolygon', 'boundary') THEN
        SELECT ST_BuildArea(ST_Collect(w.geom))
        INTO v_outer
        FROM osm.relation_members rm
        JOIN osm.ways w ON w.way_id = rm.member_id AND rm.member_type = 'way'
        WHERE rm.relation_id = p_relation_id AND rm.role = 'outer';

        SELECT ST_BuildArea(ST_Collect(w.geom))
        INTO v_inner
        FROM osm.relation_members rm
        JOIN osm.ways w ON w.way_id = rm.member_id AND rm.member_type = 'way'
        WHERE rm.relation_id = p_relation_id AND rm.role = 'inner';

        IF v_outer IS NOT NULL AND v_inner IS NOT NULL THEN
            v_geom := ST_Difference(v_outer, v_inner);
        ELSE
            v_geom := v_outer;
        END IF;
    ELSE
        -- generic case (bus/train routes, etc.): collect whatever the members'
        -- own geometries are. A node member may now be an area, which
        -- ST_Collect handles as-is.
        SELECT ST_Collect(g) INTO v_geom FROM (
            SELECT n.geom AS g
            FROM osm.relation_members rm
            JOIN osm.nodes n ON n.node_id = rm.member_id
            WHERE rm.relation_id = p_relation_id AND rm.member_type = 'node'
            UNION ALL
            SELECT w.geom AS g
            FROM osm.relation_members rm
            JOIN osm.ways w ON w.way_id = rm.member_id
            WHERE rm.relation_id = p_relation_id AND rm.member_type = 'way'
        ) sub;
    END IF;

    UPDATE osm.relations SET geom = v_geom WHERE relation_id = p_relation_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION osm.build_all_relation_geometries()
RETURNS VOID AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT relation_id FROM osm.relations LOOP
        PERFORM osm.build_relation_geometry(r.relation_id);
    END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- VIEWS
-- ============================================================================

-- One place to query every map feature (POIs, drawn areas, imported boundaries,
-- streets, buildings, transit routes) for rendering, e.g. filtering by bbox.
--
-- DROP first: the old definition had a fourth 'region' branch, and CREATE OR
-- REPLACE VIEW may only append columns, not change the body's shape.
DROP VIEW IF EXISTS public.map_features;
CREATE VIEW public.map_features AS
SELECT 'node'::text            AS feature_type,
       'osm_node_' || node_id  AS feature_id,
       geom,
       name,
       tags || jsonb_build_object(
           'source', source,
           'kind',   lower(GeometryType(geom))   -- 'point' | 'polygon' | 'multipolygon'
       )                       AS properties
FROM osm.nodes
-- Tagged nodes are POIs; untagged ones are bare way vertices and do not belong
-- on the map. An area is always a feature in its own right, tagged or not.
WHERE tags <> '{}'::jsonb OR GeometryType(geom) <> 'POINT'

UNION ALL

SELECT CASE WHEN is_area THEN 'way_polygon' ELSE 'way_line' END,
       'osm_way_' || way_id,
       geom,
       tags->>'name',
       tags
FROM osm.ways
WHERE geom IS NOT NULL

UNION ALL

SELECT 'relation'::text,
       'osm_relation_' || relation_id,
       geom,
       tags->>'name',
       tags
FROM osm.relations
WHERE geom IS NOT NULL;

-- "What layers exist?", answerable from psql. Nothing reads it — the API
-- queries both tables directly.
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

-- Example bbox query for a map viewport (swap in real coordinates):
-- SELECT feature_type, feature_id, name, ST_AsGeoJSON(geom) AS geojson
-- FROM public.map_features
-- WHERE geom && ST_MakeEnvelope(26.09, 44.44, 26.10, 44.45, 4326);
