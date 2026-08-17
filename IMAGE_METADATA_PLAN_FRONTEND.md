# Outline from photo GPS — frontend

Frontend-only, on branch `frontend_image_metadata`. No backend change: the API
already accepts everything this needs.

## Context

Creating a new node or region on `/upload` forces the user to hand-draw an
outline before the Process button unlocks. But the photos being uploaded are
drone or phone imagery, and they already carry the answer in their EXIF GPS
tags — the app is asking the user to redraw something it could read.

The Outline field gains three sources, switchable at any time, with the map
showing whichever one is active:

- **Photo outline** — the convex hull of the camera positions. Selected on its
  own as soon as GPS is found, so it is the default.
- **Mean point** — a single point at the centre of the camera positions.
- **Draw my own** — today's behaviour, unchanged.

The camera positions themselves are drawn as dots in all three modes. A photo
with a bogus GPS fix that blows the hull out to the next county is then visible
rather than mysterious, and removing it from the file list reshapes the hull
immediately.

## API contract

Nothing new. `POST /nodes` already takes **either** `{name, polygon}` **or**
`{name, lat, lon}` — the point path predates polygons and is still live — so
the mean-point option reuses it verbatim.

`POST /regions` has no lat/lon path, because `regions.geom` is typed
`MultiPolygon`. Rather than fake a tiny square around the mean, **choosing
"Mean point" switches the target type to Node and disables Region**: a point
target *is* a node in this data model. The polygon path is untouched — an open
`[[lon, lat], ...]` ring, closed and validated server-side, with `_BAD_OUTLINE`
and the vertex/area limits still reported through `checkWrite`.

The job itself carries no geometry (`POST /jobs` has no such field), so none of
this touches the job payload or the upload flow.

## Changes

**`package.json`** — add `exifr` (`^7.1.3`). `exifr.gps(file)` reads only the
header slice rather than the whole file, covers JPEG/HEIC/TIFF/PNG, and applies
the `GPSLatitudeRef`/`GPSLongitudeRef` hemisphere signs, which is the part a
hand-rolled IFD walker gets wrong. (`gpu/splat_app.py` has the Python
equivalent, `_exif_gps`/`_dms_to_degrees`, but that is dead code under GS2Mesh
and runs on Modal — reference only.)

**`src/gis/photoGps.js`** (new) — `fileKey(file)`, `readGps(file)` and
`readGpsPoints(files, onProgress)`.

- Returns **API order `[lon, lat]`**, per the invariant at the top of
  `gisGeo.js`: everything in state and payloads is lon/lat, swapped to Leaflet
  order only at the render call site.
- Rounds to 6 decimals — the same `PRECISION` the picker uses, ~0.1 m.
- Drops non-finite values, out-of-range lat/lon, and an exact `[0, 0]` fix:
  that is a broken tag write, not the Gulf of Guinea.
- `readGpsPoints` runs a bounded worker pool with the same shape as
  `uploadFilesInBatches` — claim-an-index workers over one shared cursor. A
  file with no EXIF yields `null`, not an error; a file that fails to parse is
  collected, not thrown, so one bad photo cannot sink the scan.
- `fileKey` is `name:size`, matching the key `addFiles` already dedupes on, so
  a file is never scanned twice.

**`src/gis/gisGeo.js`** — two helpers next to `ringToLatLngs`, which already
works unchanged on a bare point list:

- `convexHull(points)` — Andrew's monotone chain over `[lon, lat]`, returning an
  **open** ring to match what the picker and the server expect, or `[]` when
  fewer than three non-collinear distinct points survive. Collinear points are
  dropped with a strict cross-product test.
- `meanPoint(points)` — arithmetic mean, or `null` for an empty list.

`MAX_VERTICES` moves out of `PolygonPicker.jsx` to here as
`MAX_POLYGON_VERTICES`, so both the picker and the hull check are against the
one mirror of the server's limit. No `@turf/*` — a hull and a mean are forty
lines and the repo deliberately carries no geometry library. Worth a comment:
the hull is computed in raw lon/lat, so a set straddling the antimeridian
produces a wrapped ring, which the server's area cap rejects with a readable
message rather than storing.

**`src/components/PolygonPicker.jsx`** — the prop surface widens from
`{value, onChange}` to also take `point`, `photoPoints` and `fitKey`.

- `value` is now the ring to *render*, drawn or derived. Omitting `onChange`
  makes it read-only: `ClickToAddVertex` is not mounted, Undo/Clear are hidden,
  and the canvas carries `data-editable="0"` so the crosshair cursor reverts.
- Camera dots go in a new `photos` pane at z-index 490, below `draw` at 500 —
  small `CircleMarker`s in the empty-point colour, `interactive={false}` so
  they can never swallow a drawing click, the same reason the vector layers are
  passed `interactive={false}` today.
- The mean point renders as one larger `CircleMarker` in the splat-point
  colour with a white ring, the same vocabulary as the first-corner marker.
- **Fitting the map on a switch** is the one real addition. `MapContainer`
  reads `center`/`zoom` only at mount, so switching sources would otherwise
  leave the map parked where it was. A headless `FitToShape` child using
  `useMap()` — modelled on `FitToFeatures` in `SplatMap.jsx`, with the
  nonce-style refit trigger from `GisMap.jsx`'s `FitBoundsController` — builds
  bounds from the ring, the photo points and the point, then `fitBounds(...,
  {padding: [24, 24], maxZoom: 17})`, or `setView` at zoom 17 when a lone point
  is all there is. Keyed on `fitKey`.
- The footer line adapts: the "click the map" prompt only while editable,
  otherwise the corner count and photo count, or the mean coordinates.

Everything else stays — the GIS layer overlays, the pane order, the basemap
segmented control, and the `gv-gis-map` root class that pulls in the dark
Leaflet restyle.

**`src/components/Upload.jsx`** — `newPolygon` is replaced by an
`outlineSource` (`'photos' | 'point' | 'draw'`) plus `drawnPolygon`, with
`gpsByFile`, `gpsScanning` and `sourcePinned` alongside.

- An effect on `files` scans any file whose key is not already in `gpsByFile`,
  with the same `active` cancellation flag as the targets effect.
- `photoPoints` / `photoHull` / `photoMean` are memos derived from the *current*
  file list, not a snapshot — which is what makes deleting an outlier reshape
  the hull. `activeRing` and `activePoint` fall out of `outlineSource`.
- Auto-select sets the source to `photos` once the hull has three corners, but
  only while `!sourcePinned && drawnPolygon.length === 0`: a drawing already in
  progress is never overwritten, and any explicit click pins the choice.
- `photos` is disabled below three hull corners, `point` without a mean; if the
  active source stops being available the form falls back to `draw`.
- Selecting `point` forces `targetType` to `node` and disables the Region
  button, per the API contract above. The Node/Region buttons keep resetting
  `selectedId` and now clear `drawnPolygon` only — the derived shapes follow
  the photos, not the target type.
- `targetReady` accepts either a ring of three or a point. The create call
  sends `{name, lat, lon}` when a point is active and `{name, polygon}`
  otherwise, with a local guard on `MAX_POLYGON_VERTICES` so an absurd set gets
  a readable message instead of a server 400.
- UI: a `div.seg` radiogroup of three `label.seg-opt` above the picker — the
  same primitive as the picker's own basemap toggle — with counts in the labels
  and disabled options greyed. A muted line under the dropzone reports
  "Reading photo locations…", "9 of 12 photos have GPS", or "No photo carries
  GPS — draw the outline instead". The rail's Outline row names the source and
  its summary ("From photos · 7 corners", "Mean point · 44.42680, 26.10250",
  "Drawn · 4 corners", "Not set").

**`src/App.css`** — three rules, appended to the bands they belong to.
`.gv-coord-source` and
`.gv-coord-picker-canvas[data-editable="0"] .leaflet-container {cursor: grab}`
with the coordinate picker; `.gv-photo-gps` with the upload-page rules. Tokens
throughout, `data-*` for state, nothing in `nocturne.css`.

## Out of scope

- **Sending per-photo GPS to the backend.** Photos go browser → R2 by
  presigned PUT, so the API never sees the bytes; `CreateJobRequest` has no
  geometry field and `Job` no geometry column. EXIF georeferencing of the splat
  itself existed in `splat_app.py` and was dropped with GS2Mesh — reviving it
  is a backend and worker change, not this one.
- **A pre-existing dedupe bug**: `addFiles` dedupes on `name:size`, but
  `upload_urls` is keyed by filename alone, so two different files both named
  `IMG_001.jpg` collide onto one presigned URL and one silently overwrites the
  other. `gisConfig.js` documents the GIS path deduping by filename for exactly
  this reason. Worth a follow-up.

## Verification

The backend is not runnable locally, so this splits in two.

Client-side, with `npm run dev` alone: stamp GPS onto ~10 copies of the plain
JPEGs in `data_output/images_4/` with a throwaway `piexif` script — a ring of
coordinates, one deliberate outlier a few km out, and two or three files left
untagged. Dropping them on `/upload` under **Create new** should report the GPS
count, flip to **Photo outline** on its own, and fit the map to the hull with
every dot visible and the outlier's spike obvious. Deleting the outlier
tightens the hull and refits. **Mean point** shows one marker, greys out Region
and snaps the type to Node. **Draw my own** restores the crosshair and the
click-to-add behaviour with the dots still shown, and a ring drawn there
survives switching away and back. Photos with no GPS at all leave both derived
options disabled and the page behaving exactly as it does today. `npm run lint`
and `npm run build` clean.

End to end, with `VITE_API_URL` pointed at the deployed backend: one job per
mode. Photo outline on a region gives a `source='drawn'` boundary visible on
`/regions`; photo outline on a node gives a `footprint` polygon with its point
derived by `ST_PointOnSurface`; mean point gives a node with a `geom` point and
no footprint. Finally, tag every photo at one identical coordinate and confirm
the degenerate hull disables the option client-side rather than reaching the
server's `_BAD_OUTLINE` 400.
