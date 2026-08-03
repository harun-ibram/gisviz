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
DSM + DEM + footprints building_heights.py data_output/gis/*_heights_4326.geojson
```

These scripts live in `src/` alongside the FastAPI app: `gis_worker.py` imports
them lazily as plain modules for the upload pipeline (`/gis/*`), and each also
still runs standalone from the command line, unchanged.

## Setup

```bash
source backend/bin/activate
pip install -r src/requirements.txt
```

## Run (processing only — no database needed)

```bash
cd src
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

## Building heights and volumes

`building_heights.py` combines a LiDAR DSM/DEM pair with OSM building footprints
to derive a height and a volume per building. The point cloud is a *measurement*
source here — what gets drawn on the map is the footprint polygon, extruded by
the height derived below.

```bash
# Both rasters must come from the same tile at the same --cell, or the grids
# will not line up (the script checks and refuses a mismatched pair).
python process_lidar.py tile.laz --kind dsm --cell 1.0 --id t_dsm
python process_lidar.py tile.laz --kind dem --cell 1.0 --id t_dem
python process_vectors.py city.osm.pbf --bbox MIN_LON MIN_LAT MAX_LON MAX_LAT

python building_heights.py \
    --dsm data_output/gis/t_dsm_native.tif \
    --dem data_output/gis/t_dem_native.tif \
    --buildings data_output/gis/city_buildings_4326.geojson
```

Pass the **`*_native.tif`**, not the `*_4326.tif`. Zonal maths runs in the
raster's native metric CRS because areas and volumes computed in degrees are
meaningless; a geographic raster is rejected rather than silently measured.

Ground is the 10th percentile of the DEM in a 2 m ring *outside* the footprint
(the interpolated ground under a building is the least trustworthy part of the
surface); roof is the 75th percentile of the DSM inside it. Percentiles rather
than min/max: chimneys and antennas wreck a MAX, one stray low return wrecks a
MIN. Tune with `--ring`, `--ground-percentile`, `--roof-percentile`.

Each feature gains `ground_m`, `roof_m`, `height_m`, `footprint_area_m2`,
`volume_prism_m3`, `volume_lidar_m3`, `coverage` and `cell_count`. The two
volumes are a free correctness signal — `prism` is `area x height`, `lidar`
integrates every cell, so they agree on flat roofs and diverge on pitched ones.
Footprints with less than 30% valid LiDAR cover get a **null** height rather
than a misleading `0`, so the map can render "no data" distinctly.

## Load into PostGIS (Step 1 integration)

Bring the database up first (`docker-compose up`), then:

```bash
cd src
python load_gis.py --all                 # process raster + lidar + regions and load
python load_gis.py --all --dry-run       # process only, skip DB writes
```

`load_gis.py` ensures the `public.raster_layers` schema (`schema_gis.sql`, in
this same directory), upserts each raster overlay (bounds as a WGS84 envelope +
`overlay_path`), and upserts the cleaned `ro.json` regions into
`public.regions`. It connects with `DB_URL` from the repo-root `.env` — the
same database the FastAPI backend reads.

## Serving to the frontend

The `/gis/*` endpoints in `gis_api.py` are the live path: upload through the
frontend, `gis_worker.py` calls these same scripts in a per-job workspace, and
the result is served with signed R2 URLs. See `GIS_PLAN.md` at the repo root
for the full API contract.

Running `load_gis.py` by hand instead writes straight to `public.raster_layers`
with `storage='static'` (an `/overlays/*.png` web path served by Vite) — useful
for the two well-known local fixtures (`output_hh.tif`, the LiDAR tile) without
going through R2 at all.
