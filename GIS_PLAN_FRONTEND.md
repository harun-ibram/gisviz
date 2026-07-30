# Frontend plan — GIS upload sections + layer library + map (`/gis`)

> **Plan 2 of 2.** Written against the API contract in **`GIS_PLAN.md` §6**, which lives on the
> `backend_scripts_integration` branch (this branch does not carry it). That §6 is the contract
> between the two halves — if an endpoint shape changes, change it in both plans or neither.
>
> Naming note: the backend plan is `GIS_PLAN.md` and this one is `GIS_PLAN_FRONTEND.md`, so the
> two branches never both add a file of the same name with different content. Consider renaming
> the backend one to `GIS_PLAN_BACKEND.md` when these branches meet.

## Context

The four GIS processors (`scripts/gis/*`) are being wired into the app so users can upload
files per format. The backend plan gives them an upload→process→layer pipeline over
`/gis/*`. This plan is the UI for it: **four sections — TIFF, OSM, GeoJSON, LiDAR** — each
accepting its own formats and options, plus a layer library and a map that actually draws
the results, so a user can see that a processed file worked.

The frontend today has **no map library at all**, and its only vector renderer
(`OSMViewer.jsx`) is dead code — line 198 calls `parseOsm("")` at module scope, so it always
renders zero features. The backend deliberately pre-converts rasters to *PNG + WGS84 bbox*
and vectors to *GeoJSON*, so the frontend job is "draw a PNG inside a bounding box" and
"draw a FeatureCollection" — not GeoTIFF parsing.

**User decisions, already settled:**
1. **Leaflet + react-leaflet**, with `preferCanvas` for large vector layers.
2. **One `/gis` route with a four-tab strip** — not four routes, not tabs on `/upload`.
3. **Scope = upload + layer library + map viewer** (the full round trip).
4. **The photo→splat `/upload` flow stays completely untouched.** Duplicating a helper is
   acceptable; editing `Upload.jsx` is not. Fixing `OSMViewer.jsx` and `SplatViewer.jsx`'s
   `VITE_API_URL` bug are explicitly out of scope.

## Ground rules from the existing code

- `src/hooks/SplatLibraryProvider.jsx:4` is the **only** place `import.meta.env.VITE_API_URL`
  may be read. Everything new takes `apiBaseUrl` from `useSplatLibrary()`.
- `src/components/Upload.jsx` is **read-only reference**. Re-implement `formatBytes` (L52-62),
  the bounded upload pool (L15-50) and the poll loop (L214-235) under `src/gis/`.
- `src/index.css` imports nocturne; `src/App.css` is imported by `App.jsx` and therefore lands
  **after** it — so Leaflet's stylesheet goes in `index.css` and our dark overrides at the end
  of `App.css`, where they win at equal specificity without `!important`.
- `.seg` / `.seg-opt` (`nocturne.css:160-171`) are **radio-driven** (`:has(input:checked)`) and
  unused today — build the tab strip as `<label class="seg-opt"><input type="radio">`, not buttons.

## New files

```
src/gis/gisConfig.js       GIS_TYPES schema + FALLBACK_GIS_CONFIG + validateSelection/validateOptions
src/gis/gisApi.js          makeGisApi(apiBaseUrl) → one fn per endpoint; throws GisApiError{status,detail}
src/gis/gisErrors.js       error_kind → {title, detail, retry}; status/step labels
src/gis/gisGeo.js          toLeafletBounds, unionLeafletBounds, TERRAIN_RAMP, rampCss
src/gis/gisFormat.js       formatBytes (duplicated), formatCount, formatDuration
src/gis/uploadGisFiles.js  XHR bounded-concurrency PUT pool: per-byte progress, retry, abort
src/hooks/gisLibraryContext.js   createContext(null)          ← mirrors splatLibraryContext.js
src/hooks/GisLibraryProvider.jsx config + jobs + layers + map state + poll loop
src/hooks/useGisLibrary.js       useContext guard             ← mirrors useSplatLibrary.js
src/components/gis/GisPage.jsx          route root, tab strip, page grid
src/components/gis/GisUploadPanel.jsx   dropzone + file list + name + options + submit
src/components/gis/GisOptionsFields.jsx renders optionFields (select | number | bbox)
src/components/gis/GisBboxField.jsx     4 number inputs + "Use current map view" + Rectangle preview
src/components/gis/GisJobRail.jsx       stepper, log tail, error card, cancel/retry
src/components/gis/GisLayerLibrary.jsx  layer rows: visibility, opacity, zoom-to, delete, filters
src/components/gis/GisLayerDetail.jsx   detail rows + stats + downloads
src/components/gis/GisMap.jsx           MapContainer, basemap switch, panes, FitBoundsController
src/components/gis/GisRasterOverlay.jsx <ImageOverlay> + URL refresh + opacity
src/components/gis/GisVectorLayer.jsx   fetch GeoJSON → <GeoJSON> on canvas, feature-count guarded
src/components/gis/GisLegend.jsx        terrain ramp legend
src/components/gis/useAssetUrl.js       signed-URL TTL refresh hook
```

**Modified — five files only:** `src/App.jsx`, `src/App.css`, `src/index.css`,
`src/components/icons.jsx`, `package.json`.

### Component tree
```
<SplatLibraryProvider>              (unchanged)
 └ <GisLibraryProvider>             NEW — nests inside; it reads apiBaseUrl from that context
    └ .gv-shell
       ├ <Header/>    + <NavLink to="/gis">GIS</NavLink>
       ├ <Sidebar/>   + nav link + "GIS layers" count row
       └ /gis → <Suspense><GisPage/></Suspense>    (lazy: keeps Leaflet out of the Home/Viewer chunk)

GisPage
 ├ .gv-library-head      title + "N layers" tag
 ├ <GisTabStrip/>        .seg with 4 radio .seg-opt
 └ .gv-library-grid      (existing minmax(0,1fr) 340px grid — no new layout primitive)
    ├ .gv-library-lists  <GisUploadPanel key={active}/> · <GisMap/> · <GisLayerLibrary/>
    └ aside.gv-detail-rail   {activeJob ? <GisJobRail/> : <GisLayerDetail/>}
```
The map sits in the main column, not its own route: the whole point is "upload → watch → see
it drawn", and a finished job should push its layer onto a map already on screen.

## Config-driven tabs

`src/gis/gisConfig.js` holds UI concerns; **limits come from the server** (`GET /gis/config`)
and are merged at render time, with `FALLBACK_GIS_CONFIG` mirroring the documented response
byte-for-byte so the page still works if that endpoint fails.

Each entry in `GIS_TYPES`: `{id, label, icon, title, blurb, accept, dropHint, limitNote(config),
optionFields[]}`. `optionFields` drive the forms so **no per-type form is hand-written** —
only `GisOptionsFields.jsx` branches, on three `control` values:

| type | option fields |
|---|---|
| tiff | `kind` select — dem / dsm / raster |
| lidar | `kind` select — dem / dsm; `cell` number, 0.1–50 m, step 0.1 |
| osm | `bbox` — optional clip; help notes it's pushed into the OGR read, recommended over ~50 MB |
| geojson | `bbox` — optional clip, applied to every file |

Helpers: `defaultOptions(typeId, config)` (server defaults win over schema defaults),
`serializeOptions` (omits `bbox` entirely when null), `validateOptions`.

Per-type blurbs must state the non-obvious contract facts: OSM produces **two** layers
(buildings + roads); GeoJSON produces **one layer per file**; LiDAR DEM needs class-2 points,
so unclassified tiles must use DSM.

### Client-side pre-validation
`validateSelection(files, typeId, config) -> string[]` mirrors every documented 400 from
`POST /gis/jobs`: file count vs `max_files`, extension vs `accepted_extensions`, size vs
`max_size_bytes`, duplicate filenames.

Two details that matter:
- **Longest-suffix extension match**, so `.osm.pbf` wins over `.pbf`.
- **De-dupe and reject on filename alone** — a deliberate divergence from `Upload.jsx:186`,
  which keys on `` `${name}:${size}` ``. `upload_urls` is a `{filename: url}` map, so two
  different files named `tile.tif` would collide onto one presigned URL and silently overwrite.

Not checkable client-side: `max_raster_pixels` / `max_lidar_cells` (need the file header).
Those are shown as help text and enforced by the server's `preflight` step.

`GET /gis/config` is fetched by the provider, cached in `sessionStorage`
(`gisviz:gis-config:v1`, 10 min TTL) stale-while-revalidate. Consumers never see `null` —
the fallback fills in synchronously. When the fetch fails, one muted line: *"Using built-in
limits — couldn't reach the server for current limits."* Submit stays enabled; the server is
the real gate.

## Upload → poll state machine

**Client phases** (local to the panel until a `job_id` exists):
`idle → validating → creating → uploading(bytes) → starting → tracked`, with
`aborting → DELETE /gis/jobs/{id} → idle`. Once `/start` returns 202 the job is handed to the
provider and the panel returns to `idle`, so a second type can be queued in another tab.

**Server phases** — rail rendering per `status`:

| status | UI |
|---|---|
| `awaiting_upload` | only after a failed `/start` — offer "Retry start" |
| `queued` | pulse dot, position, cancel enabled |
| `running` | 5-dot stepper + log tail; cancel **disabled** (backend 409s on running) |
| `done` | layers appended, auto-shown, fit requested |
| `failed` | error card from `error_kind`, log kept, retry |
| `cancelled` | dismiss |

Stepper labels for `step`: `downloading → preflight → processing → uploading → indexing` =
*Fetching input · Checking size and CRS · Processing · Storing results · Indexing layers*.
`processing` is the long one and gets the `log` `<pre>` beneath it, auto-scrolled,
`max-height:160px` — the backend captures processor stdout precisely for this.

**Poll loop** lives in the provider: one recursive `setTimeout` chain over all non-terminal
jobs, first tick at 1.2 s then backing off 2 s → 4 s (after 1 min) → 8 s (after 5 min), skipped
while `document.visibilityState !== 'visible'`, with an `AbortController` on unmount. Key the
effect on `pendingKey = pendingIds.sort().join(',')`, **not on `jobs`**, or it restarts on
every poll. When a job reaches `done`, §6 guarantees `layers` is fully hydrated with signed
URLs — ingest them directly, no second request. `ingestLayers` merges by `layer_id` (matching
the backend's `ON CONFLICT DO UPDATE`) and stamps `urlIssuedAt`.

**Uploading uses XHR, not `fetch`.** `Upload.jsx:26` uses `fetch`, correct for many small
photos but wrong here — a single 500 MB `.laz` would give zero feedback for minutes.
`uploadGisFiles.js` keeps the bounded pool (`UPLOAD_CONCURRENCY = 4`, lower than the photo
flow's 6 because these files are huge) but uses `xhr.upload.onprogress`, aggregates bytes
across the pool (`Uploading 214 MB / 498 MB (43%)`), retries twice on network/5xx, never on
4xx, and supports abort. Only set `Content-Type` when `file.type` is non-empty — `.tif`/`.laz`
usually come through as `''`; if R2 ever returns `403 SignatureDoesNotMatch`, drop the header.
A 403 on upload means the URL expired → *"Upload link expired; start the job again."*

### `error_kind` → human copy (`gisErrors.js`)
Each entry is `{title, detail, retry}`, where `retry` may carry an options patch that
re-creates the job with the same files (the panel holds the `File[]` until terminal state, so
retry needs no re-pick). The high-value ones:

| kind | copy + retry |
|---|---|
| `no_ground_points` | "No ground returns — this tile has no class-2 points, so a DEM can't be built." → **"Retry as DSM"** `{kind:'dsm'}` |
| `lidar_grid_too_large` | server string (includes the minimum viable cell) → **"Retry at {2×cell} m"** |
| `raster_too_large` | "Over the {max_raster_pixels} pixel budget after reprojection. Downsample: `gdal_translate -outsize 50% 50% in.tif out.tif`" |
| `no_crs` | "Carries no CRS, so it can't be placed on a map. Re-export with one, e.g. `gdal_edit.py -a_srs EPSG:32635 file.tif`" |
| `empty_result` | "No features survived. If you set a bounding box, widen or clear it." → retry `{bbox:null}` |
| `unreadable` | "Corrupt, truncated, or not really a {ext}. Try re-exporting." |
| `oom` / `disk_full` / `queue_timeout` / `worker_restart` | plain retry with a one-line explanation |

Unknown/missing kind falls back to `job.error || 'Processing failed.'` (mirroring
`Upload.jsx:232`). The raw `log` stays under a `<details>` in **every** failure case — it is
the most useful debugging artefact and it costs nothing. HTTP errors from `/start` surface
`{"detail": …}` verbatim; the backend already writes user-grade strings. A 429 also disables
submit: *"{max_queue} jobs already pending — wait for one to finish."*

## The map

### Packages
```json
"leaflet": "^1.9.4",
"react-leaflet": "^5.0.0"
```
react-leaflet **v5** is required — v4 peers React 18 and will `ERESOLVE` against React 19.2.7.
`@react-leaflet/core` arrives transitively; do not add it. No `@types/leaflet` (no TypeScript).
**Confirm the peer range resolves at install time** rather than trusting the version pin.
Leave the pre-existing duplicate `vite` in deps+devDeps alone.

`src/index.css` gains `@import 'leaflet/dist/leaflet.css';` as the first line.

### Basemaps — free, no API key
- **Dark** (default): CARTO Dark Matter, `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`,
  `subdomains="abcd"`, `maxZoom 20`. Already dark, so the theme clash is solved at the source.
- **Streets**: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, no subdomains (OSM policy),
  `maxNativeZoom 19`. Light, so the container gets `data-basemap="osm"` and a filter is applied
  to `.leaflet-tile-pane` **only**.
- **None**: overlays on flat `--color-bg` — genuinely the best way to read a DEM.

Map `maxZoom={20}` with `maxNativeZoom` on the tile layer lets users zoom past basemap
availability to inspect a 1 m DEM without 404 tiles. Attribution is mandatory for both sources.

### The bounds swap — the single most likely bug
```js
/**
 * API `bounds` is x-y order:              [minLon, minLat, maxLon, maxLat]
 * Leaflet LatLngBounds is y-x, SW then NE: [[minLat, minLon], [maxLat, maxLon]]
 * A swap of each pair AND a regroup — not a reverse of the array.
 *
 *   API      [25.9612, 44.3312, 26.2231, 44.5510]   Bucharest
 *   Leaflet  [[44.3312, 25.9612], [44.5510, 26.2231]]
 *
 * Get it wrong and Bucharest (44.4N, 26.1E) renders at 26.1N, 44.4E — the Saudi
 * desert. That off-by-a-continent is the acceptance test.
 */
export function toLeafletBounds(bounds) { /* validate 4 finite numbers, |lat| <= 90,
    normalise min/max, pad by 1e-4 if degenerate (a single-point GeoJSON), return [[S,W],[N,E]] */ }
```
**Do not swap GeoJSON data.** `bounds_geojson` and fetched FeatureCollections are already
lon/lat and Leaflet's `GeoJSON` layer handles that itself. The swap applies to exactly three
call sites: `ImageOverlay bounds`, `fitBounds`, `<Rectangle bounds>`. Enforce it by making
`toLeafletBounds` the only export producing Leaflet-order data, and never storing
Leaflet-order bounds in the provider. The layer-list `bbox` query is in **API order**
(`getWest(),getSouth(),getEast(),getNorth()`) — the inverse.

### Structure
`MapContainer` with `preferCanvas`, plus two explicit `<Pane>`s — `gis-raster` z-400 and
`gis-vector` z-450 — so rasters never cover vectors regardless of mount order.
`FitBoundsController` uses the standard imperative-escape pattern with a
`fitRequest = {bounds, nonce}` so "zoom to" fires again on the same layer.

**Fit policy:** fit on first visible layer, and on a job completing fit to the union of its new
layers — but **never auto-fit once the user has panned** (track `userMoved` from
`dragend`/`zoomend`); show a "Zoom to new layer" button instead. Nothing is more annoying than
a map that yanks itself.

**Raster** — `<ImageOverlay url bounds opacity pane="gis-raster">`. These props *are* reactive
in react-leaflet, so the opacity slider and URL refresh work without a remount. No
`crossOrigin`: a plain `<img>` load needs no CORS (the GeoJSON `fetch` does). An `error`
handler forces a signed-URL refresh.

**Vector** — `<GeoJSON key={layer_id} data pane="gis-vector" style={…}>`. Note `data` is **not**
reactive; the `key` forces the remount. Per-sublayer styling for `buildings`/`roads`/`features`
from the accent ramp, `smoothFactor: 2` on roads. Points use `L.circleMarker` via
`pointToLayer`, never the default `L.marker` — which sidesteps the classic Vite bug where
Leaflet's `marker-icon.png` 404s, with no `L.Icon.Default` patching anywhere.
**No `onEachFeature` popup binding** — that allocates 48k Popup objects and destroys the canvas
renderer's advantage. One layer-level click handler routes the clicked feature to the detail rail.

**Legend** — `gis_common.py` colourises with a fixed 5-stop terrain LUT normalised between
**p2 and p98** (not min/max), so the legend can be colour-exact rather than decorative. Render
the ramp with ticks at `p2`, `mean` (positioned at `(mean-p2)/(p98-p2)`) and `p98`, with
`min`/`max` as muted end-caps labelled *clipped*. Unit `elevation (m)` for dem/dsm, `value` for
raster. Hidden for vectors and for empty `stats`.

## Layer library

`GET /gis/layers?limit=50&offset=0` on mount, merged with layers from finished jobs. Rows
reuse `.gv-row` plus a controls strip: visibility checkbox, name + `tag-accent` layer_type +
`tag-outline` kind/sublayer, a meta line (`feature_count.toLocaleString() + ' features'` for
vectors, `p2–p98 m` for rasters, relative `created_at`), zoom-to (`IconMap`), an opacity slider
(rasters only, default 85), and delete → `.dialog` confirm → `DELETE /gis/layers/{id}`.

Filters: search (`.gv-search-*` reused), a `.seg` multi-toggle for `layer_type`, and an
"Only in current view" checkbox re-querying with `bbox` from `map.getBounds()`.

**Group rows by `job_id`** with a subtle header when a job produced more than one layer —
one OSM job produces two and a 10-file GeoJSON job produces ten, and a flat list makes that
look like a bug.

## Signed-URL expiry

Layers carry `url_expires_in: 3600`; a tab left open past an hour has dead URLs. Centralised in
the provider: a `urlCache` keyed by asset key holding `{url, issuedAt, ttlMs}`, refreshed via
`GET /gis/asset-url?key=` at 5 minutes before expiry, with an **in-flight `Map` to dedupe
concurrent refreshes** for the same key. `useAssetUrl(key, initialUrl, expiresIn, issuedAt)`
seeds from the layer object, so no extra request happens in the common case. Three triggers:

1. **Proactive** — `setInterval(60_000)` re-signs keys of *currently visible* layers near
   expiry. Visible only; a 200-layer library must not re-sign 400 keys hourly.
2. **On `<img>` error** → force refresh.
3. **On fetch 403** → the GeoJSON fetcher retries exactly once after a forced refresh.

One CORS branch worth explicit copy: the overlay `<img>` needs no CORS but the GeoJSON `fetch`
does, and a cross-origin failure surfaces as a `TypeError` with no `status`. Catch it and say
*"The storage bucket is blocking this request (CORS). Add the app origin to the R2 bucket's
allowed GET origins."* — otherwise it reads as a frontend bug and it isn't.

## Performance — the 48k-feature case

- `preferCanvas` — one `<canvas>` per pane instead of 48k SVG nodes.
- No per-feature popups (above). `smoothFactor: 2` on roads.
- **Fetch cache**: `useRef` Map keyed by `layer_id`, LRU-capped at 6 layers / 120 MB using
  `properties.size_bytes`. Hiding keeps the cache; eviction refetches on re-show.
- **Thresholds on `feature_count`**, which is known *before* anything downloads:
  `< 20k` render immediately · `20k–150k` show a `tag-outline` warning and confirm before
  rendering (*"This layer has 48,213 features (~21 MB). Rendering may make the map sluggish."*)
  · `> 150k` refuse, offer the download link plus **clip-and-re-run** prefilling a new OSM job
  with `bbox` = current map view.
- Client-side simplification (turf/topojson) is deliberately **not** added — the backend
  already accepts a `bbox`, which is a better fix and costs no bundle.
- Fetches are wrapped in an `AbortController` tied to visibility, so toggling a layer off
  mid-download cancels a 21 MB transfer. The ~200-400 ms main-thread parse at 21 MB is
  accepted for v1 behind a `.gv-job-status` pulse row; no worker.

## State management

**A new `GisLibraryProvider`**, parallel to `SplatLibraryProvider` — not a modification of it,
not local state:
- The poll loop must survive tab switches inside `/gis` and navigation away and back; local
  state in the panel dies on unmount.
- Map, upload panel, layer library and rail all read the same layer set.
- `Sidebar` needs the layer count and lives outside the route.
- No Redux/Zustand — four fetch-backed collections and two selection sets is context-sized,
  and it matches the one pattern already in the repo.

`jobs` goes through a `useReducer` (`JOB_CREATED | JOB_PROGRESS | JOB_POLLED | JOB_FAILED |
JOB_DISMISSED`) because the poll loop and the upload progress callback write concurrently and
a `setState`-with-spread race would drop upload progress.

Kept **out** of the provider: file selection, options draft, validation problems — per-tab form
state in `GisUploadPanel`, keyed by type. The map must not re-render when someone types in a
bbox field.

## Nav wiring — `src/App.jsx`, four edits

1. Imports: `lazy`/`Suspense`, `GisPage` (lazy), `GisLibraryProvider`, `useGisLibrary`, `IconLayers`.
2. `Header()` — `<NavLink to="/gis" className={navLinkClass}>GIS</NavLink>` after Upload.
   Leave the `gv-header-meta` splat tag alone (it reads `useSplatLibrary`).
3. `Sidebar()` — a `Navigate` entry (`IconLayers` + "GIS layers"), and a third
   `.gv-side--static` row in `Collections` showing `{layers.length}`. The hardcoded
   `Backend / Connected` block stays as-is (out of scope).
4. `GisLibraryProvider` nests **inside** `SplatLibraryProvider` (it reads `apiBaseUrl` from that
   context), and the `/gis` route is wrapped in `<Suspense>` so Leaflet stays out of the
   Home/Viewer chunk.

`src/components/icons.jsx` gains four exports in the existing flat style (24 viewBox,
`stroke="currentColor"`, strokeWidth 1.6-1.7): `IconLayers`, `IconRaster`, `IconPoints`,
`IconEye`/`IconEyeOff`. `IconMap`, `IconUpload`, `IconClose`, `IconSearch`, `IconArrowRight`
are reused as-is.

## CSS

**New `gv-gis-*` classes** appended to `App.css` in one section: `.gv-gis-tabs` (makes `.seg`
full-width via `flex:1` on each `.seg-opt`), `.gv-gis-blurb`, `.gv-gis-limits`,
`.gv-gis-options`/`-option`/`-option-help`, `.gv-bbox-grid` (4-up → 2-up at 860px),
`.gv-gis-problems`, `.gv-progress`/`-bar`, `.gv-job-steps`/`.gv-step[data-state]`,
`.gv-job-log`, `.gv-error-card`/`-title`/`-detail`, `.gv-layer-row`/`-controls`, `.gv-opacity`,
`.gv-legend`/`-ramp`/`-ticks`, `.gv-gis-map`/`-head`/`-canvas` (`height:540px`,
`min-height:360px`, `radius-lg`, `overflow:hidden`), `.gv-feature-props`.

Responsive: nothing new — `.gv-library-grid` already collapses at 1100px and the sidebar hides
at 860px. Add only a 860px rule shrinking the map to 380px and the bbox grid to 2-up.

**Leaflet dark restyle** at the end of `App.css`, scoped under `.gv-gis-map`: container
background `#101220` + app font, `.leaflet-bar`/`-control-layers` on `--color-surface` with
`--color-divider` borders and accent hover, attribution on a translucent blurred `--color-bg`
with `--color-accent-300` links, popups/tooltips on `--color-surface`, and the app's
`:focus-visible` accent ring.

Two traps to call out in the code:
- `.leaflet-container` **needs an explicit height** or the map is 0px tall and everything looks broken.
- The invert filter for the light OSM basemap must be applied to `.leaflet-tile-pane` **only** —
  filtering `.leaflet-container` would render the terrain ramp and every vector in negative.

## Verification

**Setup.** `uvicorn main:app --app-dir src --host 0.0.0.0 --port 8000`; `npm install`;
`npm run dev`. Leave `VITE_API_URL` unset so `apiBaseUrl` is `/api` and the Vite proxy strips
the prefix. **Confirm `GET /api/gis/config` returns 200 before anything else** — a 404 there
means the backend router isn't mounted and every downstream failure is a red herring.

**Static.** `npm run lint` (the poll effect's omission of `jobs` from deps is intentional —
give it an explicit disable with a comment). `npm run build`, then confirm a separate lazy
chunk holds Leaflet and that `grep -c leaflet-container dist/assets/*.css` > 0.

**TIFF** — `public/output_hh.tif`, `kind=dem`. Expect create 201 → PUT with a progress bar →
202 queued → stepper walks all five steps → one raster layer. **The bounds assertion: the
overlay must sit over the real location** — if it lands in the Arabian desert the lat/lon swap
is inverted. Legend end labels must equal `stats.p2`/`p98`, not min/max. Drag opacity: the
image fades with no flicker (proves the props are reactive and there's no remount).

**OSM** — a small `.osm`, then a city `.osm.pbf` with a bbox from "Use current map view".
Expect **exactly two layers** from one job, grouped under one header. Toggling a ~48k-feature
roads layer must show the confirm dialog, and stay interactive after confirming — if it crawls,
check `map.options.preferCanvas === true` and that no `onEachFeature` popup binding crept back.
Clicking a road fills the rail; no popup opens.

**GeoJSON** — 3 files at once → three layers, `sublayer:"features"`, points as circle markers
with no `marker-icon.png` 404s. Then 11 files → blocked client-side with *"GeoJSON accepts 10
files; you selected 11"* and **zero** network requests. A `.txt` renamed to `.geojson` passes
client validation and fails server-side as `unreadable` with the right copy.

**LiDAR** — `.laz`, `kind=dem`, `cell=1.0`. On a tile with no class-2 returns expect
`no_ground_points` and a working **"Retry as DSM"** that reuses the same file without
re-picking. `cell=0.1` on a large tile → `lidar_grid_too_large` + **"Retry at 0.2 m"**.
`cell=0.05` → blocked client-side before any upload.

**Signed-URL expiry** — set `GIS_URL_TTL=60` on the backend, load a raster and a vector, wait
~90 s, then pan and toggle the vector off/on. Both keep working; the network tab shows exactly
one `asset-url` call per key, not one per tile-move (proves the in-flight dedupe).

**Queue and cancel** — start 4 jobs quickly: one running, two queued, the 4th `/start` → 429
rendered as *"3 jobs already pending"*. Cancel a queued job → `cancelled`. The cancel button is
disabled while running, and a forced 409 surfaces readably rather than crashing.

**Regression** — `/`, `/viewer`, `/upload` behave exactly as before, and `git diff --stat` must
show `Upload.jsx`, `SplatViewer.jsx`, `OSMViewer.jsx` and `SplatLibraryProvider.jsx`
**untouched**. Navigate `/gis` → `/upload` → `/gis` mid-job and confirm the poll survived.

## Follow-up, explicitly out of scope

`OSMViewer.jsx` becomes fully redundant once this lands — Leaflet renders the backend's
OSM-derived GeoJSON far better than the hand-rolled SVG projector, and its dead `parseOsm("")`
means it renders nothing today anyway. Deleting it, its `.map-svg`/`.map-loading` CSS, and the
`gv-map-panel` block in `SplatViewer.jsx` that mounts it is a clean separate PR. Same for
`SplatViewer.jsx:34` reading `VITE_API_URL` with no `/api` fallback.

## Critical files

- `/home/harun/practica/gisviz/src/App.jsx` — nav in **both** `Header` and `Sidebar`, `/gis` route, provider nesting
- `/home/harun/practica/gisviz/src/hooks/SplatLibraryProvider.jsx` — read-only: the `apiBaseUrl` source and the provider shape to mirror
- `/home/harun/practica/gisviz/src/components/Upload.jsx` — read-only: upload pool, poll loop, dropzone, page layout to re-implement
- `/home/harun/practica/gisviz/src/App.css` — new `gv-gis-*` classes + the Leaflet dark restyle at the end
- `/home/harun/practica/gisviz/src/theme/nocturne.css` — read-only: `.seg`/`.seg-opt` radio semantics and the tokens to use
- `/home/harun/practica/gisviz/package.json` — `leaflet ^1.9.4`, `react-leaflet ^5.0.0`
