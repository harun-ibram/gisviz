# GIS Processing (Step 2)

Python pipeline that turns raw geospatial inputs into map-ready layers for
GISViz. Everything is reprojected to **EPSG:4326 (WGS84)** — the CRS the React
map and the PostGIS tables use — and each raster becomes a colorized PNG
overlay plus a bounding box, because a browser can't render a raw GeoTIFF.

```
raw input            processor            artifacts                         DB (load_gis.py)
─────────────────────────────────────────────────────────────────────────────────────────
public/output_hh.tif  process_raster.py   data_output/gis/*_4326.tif        public.raster_layers
public/*.laz          process_lidar.py    public/overlays/*.png  + bounds   public.raster_layers
public/ro.json        process_vectors.py  data_output/gis/regions_4326.geojson  public.regions
data/map.osm          process_vectors.py  data_output/gis/osm_{buildings,roads}_4326.geojson
```

## Setup

```bash
source backend/bin/activate
pip install -r scripts/gis/requirements.txt
```

## Run (processing only — no database needed)

```bash
cd scripts/gis
python process_raster.py                 # Bucharest DEM  -> overlay
python process_lidar.py  --cell 1.0      # USGS LiDAR .laz -> gridded DEM -> overlay
python process_vectors.py                # ro.json + map.osm -> clean GeoJSON
python process_vectors.py city.osm.pbf   # any vector file (auto-typed by extension)
python process_vectors.py city.osm.pbf --bbox -0.42 39.44 -0.31 39.50  # clip at read time
```

`process_vectors.py` takes an optional vector file (GeoJSON / Shapefile /
`.osm` / `.osm.pbf`), auto-detected as OSM vs. generic vector by extension
(override with `--as osm|regions`). For city-sized OSM extracts, filtering to
buildings/roads happens in the OGR read (not in pandas) so a 138 MB PBF loads
without exhausting memory; add `--bbox MIN_LON MIN_LAT MAX_LON MAX_LAT` (WGS84
lon/lat) to clip to a sub-area at read time and keep the output small.

Each writes reprojected GeoTIFFs / GeoJSON to `data_output/gis/`, PNG overlays
to `public/overlays/`, and a metadata sidecar (bounds + elevation stats).

## Load into PostGIS (Step 1 integration)

Bring the database up first (`docker-compose up`), then:

```bash
cd scripts/gis
python load_gis.py --all                 # process raster + lidar + regions and load
python load_gis.py --all --dry-run       # process only, skip DB writes
```

`load_gis.py` ensures the `public.raster_layers` schema (`schema_gis.sql`),
upserts each raster overlay (bounds as a WGS84 envelope + `overlay_path`), and
upserts the cleaned `ro.json` regions into `public.regions`. It connects with
`DB_URL` from the repo-root `.env` — the same database the FastAPI backend reads.

## Serving to the frontend

The bottom of `load_gis.py` has a copy-paste `RasterLayer` model + `/raster_layers`
FastAPI endpoint stub to add on the `backend_cloudflare` branch. The endpoint
returns `overlay_path` + `ST_AsGeoJSON(bounds)`; the React map then draws each
PNG within its bounds polygon, alongside the existing node/region layers.

> Note: like `scripts/load_data.py`, this whole directory is under a
> `.gitignore`d path. Un-ignore `scripts/gis/` if you want it committed.
