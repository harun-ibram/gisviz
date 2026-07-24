-- ============================================================================
-- PostGIS schema for OSM-style map data (map.osm) + GeoJSON boundary data (ro.json)
-- Target: PostgreSQL 14+ / PostGIS 3+
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS osm;

-- ----------------------------------------------------------------------------
-- 1. NODES  (OSM <node>) — points, e.g. traffic signals, POIs, or way vertices
-- ----------------------------------------------------------------------------
CREATE TABLE osm.nodes (
    node_id     BIGINT PRIMARY KEY,
    geom        GEOMETRY(Point, 4326) NOT NULL,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    model_path  TEXT,
    "timestamp" TIMESTAMPTZ
);

CREATE INDEX idx_nodes_geom ON osm.nodes USING GIST (geom);
CREATE INDEX idx_nodes_tags ON osm.nodes USING GIN (tags);
-- Only index nodes that actually carry meaningful tags (POIs) — most nodes
-- are bare geometry vertices for ways and don't need to show up in POI search.
CREATE INDEX idx_nodes_tagged ON osm.nodes ((tags != '{}'::jsonb)) WHERE tags != '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 2. WAYS  (OSM <way>) — ordered sequences of nodes forming lines or polygons
-- ----------------------------------------------------------------------------
CREATE TABLE osm.ways (
    way_id      BIGINT PRIMARY KEY,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    "timestamp" TIMESTAMPTZ,
    is_area     BOOLEAN NOT NULL DEFAULT FALSE, -- closed ring meant to be rendered as a polygon
    geom        GEOMETRY(Geometry, 4326)        -- LineString or Polygon, built from way_nodes
);

CREATE INDEX idx_ways_geom ON osm.ways USING GIST (geom);
CREATE INDEX idx_ways_tags ON osm.ways USING GIN (tags);

-- Junction table preserving node order within a way (an OSM way is an
-- ORDERED list of node references, possibly repeating the first node to
-- close a ring — hence a surrogate PK rather than PRIMARY KEY(way_id, node_id)).
CREATE TABLE osm.way_nodes (
    way_id      BIGINT NOT NULL REFERENCES osm.ways(way_id) ON DELETE CASCADE,
    node_id     BIGINT NOT NULL REFERENCES osm.nodes(node_id),
    sequence_id INTEGER NOT NULL,
    PRIMARY KEY (way_id, sequence_id)
);

CREATE INDEX idx_way_nodes_node ON osm.way_nodes (node_id);

-- ----------------------------------------------------------------------------
-- 3. RELATIONS  (OSM <relation>) — ordered, typed, roled collections of
--    nodes/ways/(other relations), e.g. bus routes, multipolygon boundaries
-- ----------------------------------------------------------------------------
CREATE TABLE osm.relations (
    relation_id BIGINT PRIMARY KEY,
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER,
    changeset   BIGINT,
    "user"      TEXT,
    uid         BIGINT,
    "timestamp" TIMESTAMPTZ,
    geom        GEOMETRY(Geometry, 4326)  -- built from members; see osm.build_relation_geometry()
);

CREATE INDEX idx_relations_geom ON osm.relations USING GIST (geom);
CREATE INDEX idx_relations_tags ON osm.relations USING GIN (tags);

CREATE TABLE osm.relation_members (
    relation_id BIGINT NOT NULL REFERENCES osm.relations(relation_id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('node', 'way', 'relation')),
    member_id   BIGINT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    sequence_id INTEGER NOT NULL,
    PRIMARY KEY (relation_id, sequence_id)
);

CREATE INDEX idx_relation_members_member ON osm.relation_members (member_type, member_id);

-- ----------------------------------------------------------------------------
-- 4. REGIONS — simple GeoJSON-style features (ro.json: county/admin polygons)
--    Kept as its own table since it's a different data shape (flat
--    id/name/properties + geometry, no OSM node/way/relation graph).
-- ----------------------------------------------------------------------------
CREATE TABLE public.regions (
    id          TEXT PRIMARY KEY,        -- e.g. "ROSM"
    name        TEXT NOT NULL,
    source      TEXT,
    properties  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- room for any extra GeoJSON properties
    geom        GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX idx_regions_geom ON public.regions USING GIST (geom);
CREATE INDEX idx_regions_properties ON public.regions USING GIN (properties);

-- ============================================================================
-- GEOMETRY-BUILDING FUNCTIONS
-- Called by the loader after bulk-inserting nodes/way_nodes/relation_members.
-- (Deliberately not triggers: recomputing geometry row-by-row during a bulk
-- OSM import would be very slow. Call these once per way/relation after load,
-- or wrap edits to a single way/relation in the app layer and re-run them.)
-- ============================================================================

-- Build (or rebuild) a way's geometry from its ordered nodes.
-- Marks is_area = true and emits a Polygon when the ring is closed and tags
-- suggest an area feature (standard OSM "closed way = area unless it's
-- clearly a linear feature" heuristic).
CREATE OR REPLACE FUNCTION osm.build_way_geometry(p_way_id BIGINT)
RETURNS VOID AS $$
DECLARE
    v_line     GEOMETRY;
    v_closed   BOOLEAN;
    v_tags     JSONB;
    v_area     BOOLEAN;
BEGIN
    SELECT ST_MakeLine(n.geom ORDER BY wn.sequence_id)
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
-- subtract "inner" ways (holes). Anything else (routes, etc.): collect
-- member geometries as-is into a GeometryCollection.
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
        -- generic case (bus/train routes, etc.): collect whatever the
        -- members' own geometries are (nodes -> points, ways -> lines)
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
-- MAP-READY VIEW
-- One place to query everything (POIs, streets/buildings, transit routes,
-- county boundaries) for rendering, e.g. filtering by bounding box + type.
-- ============================================================================
CREATE OR REPLACE VIEW public.map_features AS
SELECT 'node'::text      AS feature_type,
       'osm_node_' || node_id AS feature_id,
       geom,
       tags->>'name'     AS name,
       tags              AS properties
FROM osm.nodes
WHERE tags <> '{}'::jsonb

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
WHERE geom IS NOT NULL

UNION ALL

SELECT 'region'::text,
       'region_' || id,
       geom,
       name,
       properties || jsonb_build_object('id', id, 'source', source)
FROM public.regions;

-- Example bbox query for a map viewport (swap in real coordinates):
-- SELECT feature_type, feature_id, name, ST_AsGeoJSON(geom) AS geojson
-- FROM public.map_features
-- WHERE geom && ST_MakeEnvelope(26.09, 44.44, 26.10, 44.45, 4326);
