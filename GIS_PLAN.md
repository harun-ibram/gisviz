# Backend plan — GIS script integration (upload → process → serve as layers)

> This is **plan 1 of 2**. It covers the backend only. A companion frontend plan lives on
> the `frontend` branch and is written against the API contract in §6 below — that section
> is the contract between the two, so change it in both places or not at all.
>
> See `Plan.md` for the separate splat-ingestion architecture, whose job/upload flow this
> pipeline deliberately mirrors.

## Context

The repo has four working GIS processing scripts in `scripts/gis/` (`process_raster.py`,
`process_lidar.py`, `process_vectors.py`, plus shared `gis_common.py`). Today they are
**CLI-only**: they read hardcoded repo paths (`public/output_hh.tif`, `data/map.osm`), write
to `data_output/gis/` and `public/overlays/`, and are run by hand on a dev machine. Nothing
in the FastAPI app can invoke them, and `public.raster_layers` — which `load_gis.py` writes —
has no SQLModel and no endpoint. The GIS pipeline and the splat pipeline are two disconnected
systems that only meet in the database.

The goal is for users to upload files through the web frontend — four separate sections
(TIFF, OSM, GeoJSON, LiDAR) — and have the backend process each in its native format and
expose the result as a map layer. The frontend already has a proven precedent for this shape:
the splat flow (`POST /jobs` → presigned PUT to R2 → `/start` → poll → done).

**Decisions made by the user, already settled:**
1. Processing runs in **FastAPI BackgroundTasks** on Railway. No Modal for GIS.
2. Artifacts go to **Cloudflare R2**, served via presigned GET (Railway disk is ephemeral,
   frontend is on Vercel — `public/overlays/*.png` cannot be served).
3. Vectors → **GeoJSON object in R2 + a metadata row**, not bulk-loaded into PostGIS.
4. **One generic pipeline** with a `layer_type` discriminator, not four endpoint sets.

## Architecture

```
Frontend (Vercel)             Railway (FastAPI, 1 process)                  R2
 1. POST /gis/jobs ────────► gis_jobs row (awaiting_upload)
    ◄── job_id + presigned PUT urls
 2. PUT file(s) ─────────────────────────────────────────────────────► gis/inputs/{job_id}/
 3. POST /gis/jobs/{id}/start ► HEAD each key, size-check, status=queued
                                BackgroundTasks.add_task(run_gis_job, job_id)
                                  └─ anyio threadpool, Semaphore(1)
                                     download ◄─────────────────────── gis/inputs/{job_id}/
                                     preflight budget guards
                                     gis_workspace(tmp) → scripts/gis/*
                                     upload artifacts ───────────────► gis/outputs/{job_id}/{layer_id}/
                                     upsert raster_layers/vector_layers
 4. GET /gis/jobs/{id} (poll) ► status + step + log + hydrated layers
 5. GET /gis/layers ──────────► layer rows + inline presigned GET urls
```

One job may produce N layers: OSM → 2 (buildings, roads), multi-file GeoJSON → one per file.

## Key design decisions

| Problem | Decision |
|---|---|
| Importing `scripts/gis/*` from `src/` | `sys.path.insert(0, <repo>/scripts/gis)` resolved from `__file__` (cwd-independent), inside a new `src/gis_runtime.py`. Processor modules imported **lazily**. **Zero edits to `scripts/gis/*.py`** — no `__init__.py` (would break their flat `import gis_common as gc`). |
| Per-job output paths | A `gis_workspace(root)` context manager that temporarily rebinds `gc.REPO_ROOT/PUBLIC_DIR/DATA_DIR/OUTPUT_DIR/OVERLAY_DIR` and restores in `finally`. Works because every processor reads these as **attribute lookups at call time**. CLI behaviour is byte-identical (it never enters the context). |
| DB session in a background task | Worker is a plain `def` (Starlette runs it in the threadpool; `async def` would block the loop for minutes) taking only `job_id: str`. It opens its own short-lived `Session(engine)` three times — mark-running, step updates, finalize. Never holds a session across processing, never receives an ORM instance. |
| OOM on Railway | `threading.BoundedSemaphore(1)` + DB-counted queue cap (429 on overflow) + per-type upload byte caps + **compute-budget preflight guards** (see below). |
| Schema | Extend `public.raster_layers` additively; new `public.vector_layers`; new `public.gis_jobs`. **Not** reusing `public.jobs` — its `target_type`/`target_id` are NOT NULL and meaningless here. |

### Why the preflight budget guards are the real OOM defence

The dominant allocation is never the input file:

- `gis_common.render_dem_overlay` does a full `src.read(1)`, then float64 casts in
  `band_stats` and `colorize_to_rgba`, plus an H×W×4 RGBA array — peak **≈33 bytes/pixel**.
  A 10 000×10 000 GeoTIFF (a ~90 MB LZW file) needs ~3.3 GB.
- `process_lidar.rasterize_laz:92` allocates `nrows*ncols*8` bytes **before** any streaming,
  sized from header bounds ÷ cell. A county `.laz` at `cell=0.5` is trivially 20 GB. The
  existing `chunk_iterator(2_000_000)` bounds *point* memory but does nothing about the grid.

Both guards are header-only reads (microseconds), run before any allocation, and produce an
actionable error. Defaults: `GIS_MAX_RASTER_PIXELS=16e6` (~530 MB peak),
`GIS_MAX_LIDAR_CELLS=25e6` (~200 MB grid).

## New files

### `src/deps.py`
Extracted verbatim from `src/main.py:39-125` to break a `main ↔ gis_api` circular import:
`r2_client`, `BUCKET`, `get_signed_url(path, expires_in=3600)`, `get_upload_url(...)`,
`get_gcp_credentials()`, `connect_with_connector()`, `engine`, `get_session()`, `SessionDep`.

One behavioural change while moving — a background job can leave a pooled connection idle for
10+ minutes and Cloud SQL will drop it:
```python
sqlalchemy.create_engine("postgresql+pg8000://", creator=getconn,
    pool_pre_ping=True, pool_recycle=1800, pool_size=5, max_overflow=5)
```

### `src/gis_schema.py`
```python
DDL_STATEMENTS: list[str]                 # §5, one statement per element
def ensure_gis_schema(engine) -> None     # executes each statement SEPARATELY
def reap_orphaned_gis_jobs(engine) -> int # queued|running -> failed on boot
```
**Do not copy `load_gis.ensure_schema`'s `exec_driver_sql(whole_file)`.** That works on
psycopg via `DB_URL`; the server is on **pg8000**, whose extended query protocol cannot run
multiple `;`-separated statements in one call. It will fail on Railway.

`reap_orphaned_gis_jobs` exists because Railway redeploys kill in-flight `BackgroundTasks` —
without it jobs hang in `running` forever. Sets `error_kind='worker_restart'`.

### `src/gis_runtime.py`
GDAL/PROJ env set at module import, **before** anything can import rasterio/pyogrio
(`GDAL_CACHEMAX` is read at GDAL init and otherwise defaults to 5% of host RAM):
```python
os.environ.setdefault("GDAL_CACHEMAX", "256")          # MB
os.environ.setdefault("GDAL_NUM_THREADS", "1")
os.environ.setdefault("OSM_MAX_TMPFILE_SIZE", "100")   # MB, then spills to CPL_TMPDIR
os.environ.setdefault("CPL_TMPDIR", "/tmp")
os.environ.setdefault("PROJ_NETWORK", "OFF")
```
Contents:
- `GisConfig` / `CONFIG` — all limits from env (see §8), `ACCEPTED_EXTENSIONS` per type.
- `_resolve_scripts_dir()` — `GIS_SCRIPTS_DIR` else `Path(__file__).resolve().parents[1]/"scripts"/"gis"`;
  asserts `gis_common.py` exists, else raises loudly.
- `load_processors() -> Processors` — `@lru_cache(1)`; inserts on `sys.path`, imports the four
  modules. First call ~2–4 s / ~200 MB RSS; never called at app import.
- `gis_workspace(root) -> Workspace` — the rebinding context manager. Layout
  `root/{input,output,public/overlays}`. With `PUBLIC_DIR = root/public`,
  `overlay_web_path()` still returns exactly `/overlays/{id}.png`; with `REPO_ROOT = root`,
  `rel_to_repo()` still returns `output/{id}_4326.tif`. **Invariant:** rebinds module globals,
  so exactly one job may be inside a workspace at a time — assert this so a future
  `GIS_MAX_CONCURRENCY=2` fails loudly instead of corrupting paths.
- `capture_stdout(limit=8192)` — `redirect_stdout` into a `StringIO`. The processors are
  print-heavy, so this turns their existing CLI prints into user-visible progress for free.
  Process-global, safe only at concurrency 1; uvicorn's logging binds stderr so it is unaffected.
- `check_raster_budget(src, max_pixels)` / `check_lidar_budget(src, cell, max_cells)` —
  header-only; raise `GisInputError` including the minimum viable cell size for LiDAR.
- `check_disk(root, needed)`, `r2_download/upload/head/delete_prefix`, `GisInputError(kind, message)`.

### `src/gis_worker.py`
```python
_GIS_SLOT = threading.BoundedSemaphore(CONFIG.max_concurrency)

@dataclass
class LayerResult:
    layer_id: str; geometry_class: str        # "raster" | "vector"
    layer_type: str; name: str
    kind: str | None; sublayer: str | None
    source: str; src_crs: str | None
    bounds4326: list[float] | None
    stats: dict; properties: dict; feature_count: int | None
    artifacts: dict[str, Path]                # {"overlay.png": Path, ...}

def run_gis_job(job_id: str) -> None:         # BackgroundTasks entrypoint — sync def
```
Flow: load job, bail unless `status=="queued"` → acquire slot (timeout → `queue_timeout`) →
re-read status (cancel window) → `running`/`downloading` → mkdtemp → `check_disk` → download
each input to a **deterministic local filename** (not the user's — `process_vectors` derives
output names from `src.stem` at `process_vectors.py:128,149`; for `.osm.pbf` its own
`prefix[:-len(".osm")]` strip at L150-151 then yields exactly the layer id base) → `preflight`
guards → `processing` inside `gis_workspace` + `capture_stdout` → `uploading` → `indexing`
(**one transaction**: upsert all layer rows + finalize the job) → best-effort delete of
`gis/inputs/{job_id}/` → `finally: rmtree`, release slot.

Per-type handlers, all calling the unmodified scripts:
- `_handle_tiff` → `p.raster.process_raster(src, layer_id, name, opts["kind"])`.
  Paths reconstructed from the returned dataclass (authoritative, relative to the rebound
  root): `tif = ws.root/layer.geotiff_path`, `png = ws.root/"public"/layer.overlay_path.lstrip("/")`.
- `_handle_lidar` → `p.lidar.process_lidar(src, layer_id, name, opts["kind"], opts["cell"])`;
  plus `native = ws.root/layer.properties["native_geotiff"]`.
- `_handle_osm` → `p.vectors.process_osm(src, bbox=opts.get("bbox"))` returns
  `{"buildings": {count,bounds4326,path}, "roads": {...}}`. One `LayerResult` per sublayer
  with `count > 0`; if all empty → `GisInputError("empty_result", ...)`.
- `_handle_geojson` → one `p.vectors.process_regions(src, bbox=...)` per file, `sublayer="features"`.
  `src_crs` must be read separately with `pyogrio.read_info(src)["crs"]` — `process_regions`
  does not return it.

`classify(exc) -> error_kind`:

| exception | `error_kind` |
|---|---|
| `ValueError: ... has no CRS` (`gis_common.py:130`), `LAS file has no CRS` (`process_lidar.py:51`) | `no_crs` |
| `ValueError: No ground-classified (class 2) points` (`process_lidar.py:118`) | `no_ground_points` (message rewrites the script's own advice as `retry with kind="dsm"`) |
| `RasterioIOError`, `pyogrio.errors.DataSourceError` | `unreadable` |
| pyogrio "Could not detect geometry type" / 0-feature write | `empty_result` |
| `MemoryError` / `OSError: No space left` | `oom` / `disk_full` |
| else | `internal` |

Layer inserts reuse the shape of `load_gis.upsert_raster_layer` — raw `text()` with
`ON CONFLICT (id) DO UPDATE` and `ST_MakeEnvelope`, matching how `main.py:create_node`
already writes geometry (SQLModel cannot express `ST_MakeEnvelope`).

**Degenerate-envelope guard:** `ST_MakeEnvelope(x,y,x,y,4326)` returns a `POINT`, which
violates `GEOMETRY(Polygon,4326)` and aborts the insert — reachable with a single-point
GeoJSON. Pad by `1e-9` on each degenerate axis before inserting.

**Name collision:** `models.RasterLayer` (row) vs `gis_common.RasterLayer` (dataclass). Import
as `from models import RasterLayer as RasterLayerRow`; refer to the dataclass only as `gc.RasterLayer`.

### `src/gis_api.py`
`APIRouter(prefix="/gis", tags=["gis"])` — Pydantic request/response models and all routes
(§6). Imports from `deps`, never from `main`.

## Schema (§5)

Appended to `src/gis_schema.py::DDL_STATEMENTS` **and** mirrored into
`scripts/gis/schema_gis.sql` so the CLI loader stays in sync.

```sql
-- 1. Extend raster_layers (tiff + lidar). overlay_path/geotiff_path now hold an R2
--    key for server-produced rows, as osm.nodes.model_path does for splats.
--    `storage` disambiguates legacy '/overlays/x.png' rows written by the CLI loader.
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS layer_type TEXT NOT NULL DEFAULT 'tiff';
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS storage    TEXT NOT NULL DEFAULT 'r2';
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS job_id     TEXT;
ALTER TABLE public.raster_layers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE public.raster_layers SET storage='static'  WHERE overlay_path LIKE '/%'     AND storage    <> 'static';
UPDATE public.raster_layers SET layer_type='lidar' WHERE properties ? 'cell_size_m' AND layer_type <> 'lidar';
CREATE INDEX IF NOT EXISTS idx_raster_layers_job     ON public.raster_layers (job_id);
CREATE INDEX IF NOT EXISTS idx_raster_layers_created ON public.raster_layers (created_at DESC);

-- 2. Vector results (osm + geojson). Features live in R2; this row is metadata + envelope.
CREATE TABLE IF NOT EXISTS public.vector_layers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    layer_type    TEXT NOT NULL CHECK (layer_type IN ('osm','geojson')),
    sublayer      TEXT NOT NULL DEFAULT 'features'
                  CHECK (sublayer IN ('buildings','roads','features')),
    source        TEXT, src_crs TEXT,
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

-- 3. GIS jobs. Separate from public.jobs (whose target_type/target_id are NOT NULL and
--    meaningless here, whose status vocabulary lacks 'queued', and which carries modal_call_id).
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
    output_prefix TEXT, error TEXT, error_kind TEXT, log TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gis_jobs_status  ON public.gis_jobs (status);
CREATE INDEX IF NOT EXISTS idx_gis_jobs_created ON public.gis_jobs (created_at DESC);

-- 4. Discovery view. DROP+CREATE, not CREATE OR REPLACE: the existing view
--    (schema_gis.sql:32-40) has a different column list, and CREATE OR REPLACE VIEW
--    may only append columns. Nothing reads it — the API queries both tables directly.
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
```

Matching SQLModel classes appended to `src/models.py`: `RasterLayer`, `VectorLayer`, `GisJob`
— following the existing `Region`/`Job` style (`sa_column=Column(JSONB, ...)` for dicts,
`GeometryType("Polygon", 4326)` for `bounds`, `DateTime(timezone=True)` for timestamps).

### R2 key layout
```
gis/inputs/{job_id}/{original_filename}
gis/outputs/{job_id}/{layer_id}/overlay.png        # raster:  image/png
gis/outputs/{job_id}/{layer_id}/wgs84.tif          # raster:  image/tiff
gis/outputs/{job_id}/{layer_id}/native.tif         # lidar only
gis/outputs/{job_id}/{layer_id}/features.geojson   # vector:  application/geo+json
```
Namespaced under `gis/` so a lifecycle rule can expire `gis/inputs/` (7 days) without touching
the splat flow's `inputs/` and `models/`. Set `ContentType` explicitly on upload. The `{id}.json`
sidecar the scripts write is **not** uploaded — the DB row is the metadata API.

## API contract (§6) — the frontend plan is written against this

All under `/gis`. Times ISO-8601 UTC. Errors are FastAPI `{"detail": "..."}`.

### `GET /gis/config`
Limits, so the frontend validates before wasting an upload.
```json
{ "layer_types": ["tiff","osm","geojson","lidar"],
  "accepted_extensions": {"tiff":[".tif",".tiff"], "lidar":[".laz",".las"],
                          "osm":[".osm",".pbf",".xml",".osm.pbf"], "geojson":[".geojson",".json"]},
  "max_files": {"tiff":1,"lidar":1,"osm":1,"geojson":10},
  "max_size_bytes": {"tiff":314572800,"lidar":524288000,"osm":262144000,"geojson":104857600},
  "max_raster_pixels": 16000000, "max_lidar_cells": 25000000,
  "max_queue": 3, "url_ttl_seconds": 3600,
  "defaults": {"tiff":{"kind":"dem"}, "lidar":{"kind":"dem","cell":1.0}} }
```

### `POST /gis/jobs` → `201`
Request: `{"layer_type":"tiff","name":"Bucharest DEM","files":[{"filename":"output_hh.tif","size_bytes":45123456}],"options":{"kind":"dem"}}`

`options` (one flat model, per-type validator — not a discriminated union, keeps 422s readable):

| type | field | values | default | rule |
|---|---|---|---|---|
| tiff | `kind` | `dem\|dsm\|raster` | `dem` | matches the `raster_layers.kind` CHECK |
| lidar | `kind` | `dem\|dsm` | `dem` | |
| lidar | `cell` | float | `1.0` | `0.1 ≤ cell ≤ 50.0`, metres |
| osm / geojson | `bbox` | `[minLon,minLat,maxLon,maxLat]` or `null` | `null` | min<max, lon∈[-180,180], lat∈[-90,90] |

Response:
```json
{ "job_id":"3f2a…", "layer_type":"tiff", "name":"Bucharest DEM", "status":"awaiting_upload",
  "input_prefix":"gis/inputs/3f2a…/",
  "upload_urls":{"output_hh.tif":"https://<acct>.r2.cloudflarestorage.com/…X-Amz-Signature=…"},
  "expires_in":3600, "options":{"kind":"dem"} }
```
Client `PUT`s the raw body to each URL with **no auth header** (identical to the splat flow).
`400` on: unknown `layer_type`, empty `files`, count over `max_files`, extension not accepted,
`size_bytes` over cap, option out of range, duplicate filenames.

### `POST /gis/jobs/{job_id}/start` → `202`
No body. Server `HEAD`s every declared key, records the real `ContentLength`, sets
`status="queued"`, enqueues the worker. → `{"job_id":"3f2a…","status":"queued","queue_position":1}`
Errors: `404`; `409 job already started (status=running)`; `400 missing upload: output_hh.tif`;
`400 output_hh.tif is 812 MB; the limit for tiff is 300 MB`; `429 GIS queue is full (3 pending)`.

### `GET /gis/jobs/{job_id}`
```json
{ "job_id":"3f2a…", "layer_type":"lidar", "name":"USGS tile",
  "status":"running", "step":"processing", "error":null, "error_kind":null,
  "log":"[lidar] 17,124,880 pts, CRS EPSG:6347\n[lidar] grid 1500x1500 @ 1.0 m  (dem)\n…",
  "options":{"kind":"dem","cell":1.0},
  "input_files":[{"filename":"tile.laz","size_bytes":214000000,"key":"gis/inputs/3f2a…/tile.laz"}],
  "layer_ids":[], "layers":[],
  "created_at":"2026-07-28T12:00:00Z", "started_at":"2026-07-28T12:00:04Z", "finished_at":null }
```
`status` ∈ `awaiting_upload|queued|running|done|failed|cancelled`.
`step` (only while running) ∈ `downloading|preflight|processing|uploading|indexing`.
`error_kind` (only when failed) ∈ `missing_input|too_large|unsupported_extension|unreadable|
no_crs|no_ground_points|raster_too_large|lidar_grid_too_large|empty_result|oom|disk_full|
queue_timeout|worker_restart|internal`.
When `status=="done"`, **`layers` is fully hydrated with signed URLs** so the frontend can add
the layer to the map without a second request.

### `GET /gis/jobs?status=&layer_type=&limit=50&offset=0`
`{"jobs":[<job object, minus `layers` and `log`>], "total":12}`

### `DELETE /gis/jobs/{job_id}`
Cancels (`awaiting_upload|queued` → `cancelled`) or purges a terminal job (inputs + every
produced layer row and object). → `{"job_id":"…","status":"cancelled","deleted_layers":2,"deleted_objects":5}`.
`409` if `running` — BackgroundTasks are not interruptible.

### `GET /gis/layers`
Query: `layer_type` (comma list), `kind`, `geometry_class` (`raster|vector`), `job_id`,
`bbox=minLon,minLat,maxLon,maxLat` (server-side `ST_Intersects`), `limit`, `offset`.
→ `{"layers":[<layer object>], "total":7}`

### `GET /gis/layers/{layer_id}` → one `<layer object>`, else `404`

**`<layer object>`** — one shape for all four types; inapplicable fields are `null`:
```json
{ "layer_id":"tiff_bucharest_dem_3f2a1b7c", "layer_type":"tiff", "geometry_class":"raster",
  "name":"Bucharest DEM", "kind":"dem", "sublayer":null,
  "source":"output_hh.tif", "src_crs":"EPSG:32635",
  "bounds":[25.9612,44.3312,26.2231,44.5510],
  "bounds_geojson":{"type":"Polygon","coordinates":[[[25.9612,44.3312],"…"]]},
  "overlay_key":"gis/outputs/3f2a…/tiff_bucharest_dem_3f2a1b7c/overlay.png",
  "overlay_url":"https://…X-Amz-Signature=…",
  "geotiff_key":"gis/outputs/…/wgs84.tif", "geotiff_url":"https://…",
  "geojson_key":null, "geojson_url":null, "feature_count":null,
  "stats":{"min":54.2,"max":118.9,"mean":79.4,"p2":60.1,"p98":104.7,"count":3128400},
  "properties":{"nodata":-9999.0,"band_count":1},
  "job_id":"3f2a…", "created_at":"2026-07-28T12:03:11Z", "url_expires_in":3600 }
```
Vector example (OSM roads):
```json
{ "layer_id":"osm_valencia_9c1d2e3f_roads", "layer_type":"osm", "geometry_class":"vector",
  "name":"Valencia — roads", "kind":null, "sublayer":"roads",
  "source":"valencia.osm.pbf", "src_crs":"EPSG:4326",
  "bounds":[-0.42,39.44,-0.31,39.50], "bounds_geojson":{"type":"Polygon","coordinates":"…"},
  "overlay_key":null,"overlay_url":null,"geotiff_key":null,"geotiff_url":null,
  "geojson_key":"gis/outputs/9c1d…/osm_valencia_9c1d2e3f_roads/features.geojson",
  "geojson_url":"https://…", "feature_count":48213,
  "stats":{}, "properties":{"size_bytes":21384112,"bbox_applied":[-0.42,39.44,-0.31,39.50]},
  "job_id":"9c1d…", "created_at":"2026-07-28T12:10:44Z", "url_expires_in":3600 }
```
`bounds` is read as `ST_XMin/ST_YMin/ST_XMax/ST_YMax` scalars in the same `select()` as the row
(an image overlay wants the array, not a polygon); `bounds_geojson` comes from
`ST_AsGeoJSON(bounds)` in that same query — the `_row_to_dict` pattern at `src/main.py:140`.

Note for the frontend plan: GeoJSON layers from `process_regions` carry `label_lon`/`label_lat`
on every feature (`process_vectors.py:123-124`), usable for marker placement.

### `DELETE /gis/layers/{layer_id}` → `{"layer_id":"…","deleted_objects":2}`
### `GET /gis/asset-url?key=gis/outputs/…` → `{"url":"…","filename":"overlay.png","expires_in":3600}`
Refreshes an expired URL. `400` unless `key` starts with `gis/` — prevents this becoming an
open signer for the whole bucket (a weakness the existing `/splat-url` has).

**Layer id generation is server-side only**, no client override — otherwise the
`ON CONFLICT (id) DO UPDATE` upsert lets one user silently overwrite another's layer.
Format: `{layer_type}_{slug(name)[:32]}_{job_id[:8]}`, plus `_{sublayer}` for OSM and
`_{index}` for multi-file GeoJSON.

**Optional auth:** if `GIS_API_KEY` is set, all `POST`/`DELETE` `/gis/*` require `X-API-Key`;
unset (default) leaves them open, matching the rest of this API. Recommended before public
launch — anyone can otherwise burn the single worker slot and R2 storage.

## Changes to existing files

**`src/main.py`**
1. Replace L39–125 with `from deps import SessionDep, engine, get_signed_url, get_upload_url, r2_client`. Nothing else in the file changes.
2. Replace `app = FastAPI()` (L129) with a lifespan that calls `ensure_gis_schema(engine)`
   (gated on `GIS_AUTO_MIGRATE`, default on) and `reap_orphaned_gis_jobs(engine)` — **both
   wrapped in try/except that logs a warning**, so a DDL problem can never brick the API.
3. `app.include_router(gis_router)` after the CORS middleware.

**`src/models.py`** — append the three new models. Existing models untouched.

**`src/requirements.txt`** — add, **pinned exactly** to what the working `backend/` venv has
(capture with `pip freeze | grep -Ei 'rasterio|pyproj|geopandas|shapely|pyogrio|laspy|lazrs|numpy|pillow'`).
The `>=` ranges in `scripts/gis/requirements.txt` are fine on a dev box but will silently pull
a new GDAL major on a future Railway rebuild.

**`scripts/gis/schema_gis.sql`** — append the §5 DDL, with a comment noting the server applies
the same statements from `src/gis_schema.py` because pg8000 cannot batch.

**`scripts/gis/*.py`** — **no changes.** This is a design goal, verified by the smoke test below.

**New root-level deploy files** (nixpacks' Python provider keys off a root `requirements.txt`;
there is none today, so the service is dashboard-configured and `scripts/` may not be in the image):
- `requirements.txt` → `-r src/requirements.txt`
- `Procfile` → `web: uvicorn main:app --app-dir src --host 0.0.0.0 --port $PORT`
  (`--app-dir` puts `src/` on `sys.path` without `cd`, so `parents[1]/scripts/gis` resolves).

**Dead code to delete in the same PR:** `src/database.py` and `src/server/` — both are broken
(`src/server/main.py` uses `os.environ` without `import os` and imports a nonexistent
`database.get_session`). `deps.py` supersedes both; leaving them is a trap.

## Deploy cost and the two risks to pre-verify (§8)

All GIS wheels are manylinux2014 with vendored natives — **no apt packages needed**. Total
**~400–500 MB added** (dominated by two independent GDAL copies: rasterio's and pyogrio's);
image ~250 MB → ~700–750 MB, build +60–120 s, no compilation. **Cold start is unaffected**
because `load_processors()` is lazy; the first GIS job pays ~2–4 s and ~200 MB resident.
Size the Railway plan for **≥2 GB** (200 MB resident + ~530 MB raster peak + headroom).

1. **Railway root directory.** If it is set to `src/`, the `scripts/` tree is not in the
   container at all and `_resolve_scripts_dir()` raises at first use. Fix: set Root Directory
   to the repo root and add the root `requirements.txt` + `Procfile`. Escape hatch: set
   `GIS_SCRIPTS_DIR`, or move the four scripts to `src/gis_scripts/` (they still import each
   other flatly and the CLI still works from that directory).
2. **GDAL OSM driver in the pyogrio wheel.** `process_osm` reads the `multipolygons`/`lines`
   layers, which exist only if the bundled GDAL was built with the OSM driver (SQLite + Expat).
   Check `python -c "import pyogrio; print('OSM' in pyogrio.list_drivers())"`. If `False`, the
   OSM section needs a Docker image on `ghcr.io/osgeo/gdal:ubuntu-small-*` — a substantially
   different deploy, so verify before Phase 3.

New Railway env vars: `GIS_SCRIPTS_DIR` (optional), `GIS_TMP_DIR=/tmp/gisviz`,
`GIS_MAX_CONCURRENCY=1`, `GIS_MAX_QUEUE=3`, `GIS_MAX_RASTER_PIXELS=16000000`,
`GIS_MAX_LIDAR_CELLS=25000000`, `GIS_MAX_BYTES_{TIFF,LIDAR,OSM,GEOJSON}`, `GIS_URL_TTL=3600`,
`GIS_AUTO_MIGRATE=1`, `GIS_API_KEY` (optional).

**R2 bucket CORS must allow the frontend origins for both `PUT` and `GET`** with
`AllowedHeaders: ["*"]`. PUT is likely already configured (the splat flow uses presigned PUT);
GET is new and mandatory — the browser `fetch()`es GeoJSON outputs cross-origin. Add a
lifecycle rule expiring `gis/inputs/` after 7 days.

## Implementation order

- **Phase 0 — deploy plumbing (gates everything).** Root `requirements.txt` + `Procfile`, set
  Railway root dir, deploy. In the container verify
  `python -c "import rasterio, geopandas, laspy, pyogrio; print(pyogrio.list_drivers().get('OSM'))"`
  and that `scripts/gis/gis_common.py` is present. No app code yet.
- **Phase 1 — schema.** `src/gis_schema.py`, the three SQLModels, `schema_gis.sql`, lifespan
  wiring. Deploy; confirm tables + view exist and `/nodes`, `/regions`, `/jobs` still work.
- **Phase 2 — runtime shim.** `src/deps.py`, `src/gis_runtime.py`. Pass the §11.1 smoke test
  before writing any HTTP code.
- **Phase 3 — worker.** `src/gis_worker.py`, all four handlers, guards, error classifier.
  Drive from a REPL against manually-uploaded R2 keys before there is an API.
- **Phase 4 — API.** `src/gis_api.py` + `include_router`; curl walk-through per type.
- **Phase 5 — ops.** Deletion endpoints, input cleanup, R2 lifecycle rule, CORS confirmation,
  delete `src/database.py` + `src/server/`.

## Verification

**Workspace shim (no HTTP, no R2)** — from `src/`, with the repo's `public/output_hh.tif`:
```python
from pathlib import Path; import tempfile, shutil
from gis_runtime import load_processors, gis_workspace
p = load_processors()
root = Path(tempfile.mkdtemp()).resolve()
(root/"input").mkdir(); shutil.copy("../public/output_hh.tif", root/"input/t.tif")
with gis_workspace(root) as ws:
    layer = p.raster.process_raster(root/"input/t.tif", "t", "T", "dem")
assert layer.overlay_path == "/overlays/t.png"        # overlay_web_path survived
assert layer.geotiff_path == "output/t_4326.tif"      # rel_to_repo survived
assert (root/"public/overlays/t.png").exists()
assert p.gc.OUTPUT_DIR == Path("../data_output/gis").resolve()   # globals restored
```
Then confirm the CLI is untouched: `cd scripts/gis && python process_raster.py` still writes to
`data_output/gis/` + `public/overlays/`, and `git diff --stat scripts/gis/` shows only `schema_gis.sql`.

**End-to-end per type (curl).** For each of tiff/osm/geojson/lidar: `POST /gis/jobs` →
`curl -X PUT --upload-file <f> "<upload_url>"` → `POST /gis/jobs/{id}/start` → poll to `done` →
`GET /gis/layers` → `curl -I "<overlay_url>"` returns `200 Content-Type: image/png` →
`curl "<geojson_url>" | jq '.features | length'` matches `feature_count`. Confirm OSM produces
exactly two layer rows and multi-file GeoJSON one row per file.

**Failure paths** — each must end `status=failed` with the right `error_kind`, never a 500,
never a hung job: CRS-stripped GeoTIFF → `no_crs`; `.laz` with no class-2 returns →
`no_ground_points` (message suggests `kind:"dsm"`); 12000×9000 GeoTIFF → `raster_too_large`
rejected in `preflight` (watch Railway metrics: RSS must not spike); `.laz` with `cell:0.1`
over a 5 km tile → `lidar_grid_too_large` with a suggested minimum cell; renamed `.txt` →
`unreadable`; `/start` without uploading → `400 missing upload`; a bbox excluding everything →
`empty_result` with **no** zero-feature row created; a single-point GeoJSON → succeeds with a
valid padded Polygon rather than an `ST_MakeEnvelope` type error.

**Concurrency / lifecycle.** Three jobs back to back → exactly one `running`, rest `queued`, a
4th `/start` → `429`. Redeploy mid-job → `failed`/`worker_restart`, not stuck.
`DELETE` a `queued` job → the worker sees `cancelled` after acquiring the slot and exits.
Idle 30 min after a job then hit `/gis/layers` → no `InterfaceError` (validates `pool_pre_ping`).
After success, `gis/inputs/{job_id}/` is empty and `/tmp/gisviz` has no leftover `gis-*` dirs.

**Regression.** `/nodes`, `/regions`, `/splat_nodes`, `/splat-url`, and the full splat
`POST /jobs` → `/start` → `/webhook` flow all still work after the `deps.py` extraction and
the lifespan change.

## Critical files

- `/home/sunny/practica/gisviz/src/main.py` — deps extraction, lifespan, router include
- `/home/sunny/practica/gisviz/src/models.py` — three new models
- `/home/sunny/practica/gisviz/scripts/gis/gis_common.py` — the module globals `gis_workspace` rebinds (read-only)
- `/home/sunny/practica/gisviz/scripts/gis/process_vectors.py` — `src.stem`-derived output naming drives the deterministic download filename
- `/home/sunny/practica/gisviz/scripts/gis/schema_gis.sql` — DDL mirror
- `/home/sunny/practica/gisviz/scripts/gis/load_gis.py` — `upsert_raster_layer` is the SQL shape to reuse
