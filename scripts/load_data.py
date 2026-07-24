import json
import xml.etree.ElementTree as ET
import psycopg2
from psycopg2.extras import execute_values

conn = psycopg2.connect(dbname="mapdb", user="postgres", password="postgres", host="localhost")
cur = conn.cursor()

# ---------------------------------------------------------------- map.osm --
tree = ET.parse("/mnt/user-data/uploads/map.osm")
root = tree.getroot()

def tags_of(el):
    return json.dumps({t.get("k"): t.get("v") for t in el.findall("tag")})

nodes, ways, way_nodes, relations, relation_members = [], [], [], [], []

for el in root:
    if el.tag == "node":
        nodes.append((
            int(el.get("id")), float(el.get("lon")), float(el.get("lat")),
            tags_of(el), el.get("version"), el.get("changeset"),
            el.get("user"), el.get("uid"), el.get("timestamp"),
        ))
    elif el.tag == "way":
        way_id = int(el.get("id"))
        ways.append((
            way_id, tags_of(el), el.get("version"), el.get("changeset"),
            el.get("user"), el.get("uid"), el.get("timestamp"),
        ))
        for i, nd in enumerate(el.findall("nd")):
            way_nodes.append((way_id, int(nd.get("ref")), i))
    elif el.tag == "relation":
        rel_id = int(el.get("id"))
        relations.append((
            rel_id, tags_of(el), el.get("version"), el.get("changeset"),
            el.get("user"), el.get("uid"), el.get("timestamp"),
        ))
        for i, m in enumerate(el.findall("member")):
            relation_members.append((rel_id, m.get("type"), int(m.get("ref")), m.get("role") or "", i))

execute_values(cur, """
    INSERT INTO osm.nodes (node_id, geom, tags, version, changeset, "user", uid, "timestamp")
    VALUES %s ON CONFLICT DO NOTHING
""", nodes, template="(%s, ST_SetSRID(ST_MakePoint(%s,%s),4326), %s, %s, %s, %s, %s, %s)")

execute_values(cur, """
    INSERT INTO osm.ways (way_id, tags, version, changeset, "user", uid, "timestamp")
    VALUES %s ON CONFLICT DO NOTHING
""", ways)

execute_values(cur, """
    INSERT INTO osm.way_nodes (way_id, node_id, sequence_id) VALUES %s ON CONFLICT DO NOTHING
""", way_nodes)

execute_values(cur, """
    INSERT INTO osm.relations (relation_id, tags, version, changeset, "user", uid, "timestamp")
    VALUES %s ON CONFLICT DO NOTHING
""", relations)

execute_values(cur, """
    INSERT INTO osm.relation_members (relation_id, member_type, member_id, role, sequence_id)
    VALUES %s ON CONFLICT DO NOTHING
""", relation_members)

conn.commit()
print(f"Loaded {len(nodes)} nodes, {len(ways)} ways, {len(relations)} relations")

# Build derived geometries
cur.execute("SELECT osm.build_all_way_geometries();")
cur.execute("SELECT osm.build_all_relation_geometries();")
conn.commit()
print("Built way/relation geometries")

# ---------------------------------------------------------------- ro.json --
with open("/mnt/user-data/uploads/ro.json") as f:
    geo = json.load(f)

regions = []
for feat in geo["features"]:
    props = feat["properties"]
    geom_json = json.dumps(feat["geometry"])
    regions.append((props["id"], props["name"], props.get("source"), json.dumps(props), geom_json))

execute_values(cur, """
    INSERT INTO public.regions (id, name, source, properties, geom)
    VALUES %s ON CONFLICT DO NOTHING
""", regions, template="(%s, %s, %s, %s, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)))")

conn.commit()
print(f"Loaded {len(regions)} regions")

cur.close()
conn.close()
