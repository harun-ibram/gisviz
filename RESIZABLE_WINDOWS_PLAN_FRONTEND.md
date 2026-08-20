# Resizable windows — frontend

## Context

Two pages have maps and viewers locked to sizes chosen in CSS, with no way for
the user to trade space between them:

- **Upload** (`/upload`) — the outline picker map is a hard `height: 220px`
  (`App.css:609`). Drawing a polygon or checking a photo outline in a 220px
  slot is cramped, and the component even hard-codes an assumption about it
  (`MAX_PICKER_FEATURES` in `PolygonPicker.jsx` is justified by "this map is a
  220px picker").
- **Visualizer** (`/viewer`) — the splat stage and the location map share a grid
  whose column template is an inline style, fixed at `minmax(0,1fr) 320px`
  (`SplatViewer.jsx:1361`). The map is either 320px or hidden entirely; there is
  no middle ground for someone comparing the splat against its location.

The outcome: drag the bottom edge of the Upload map to make it taller, and drag
the divider between the splat stage and the map on the Visualizer to trade width
between them. Everything adjacent reflows — the sections below the Upload map
shift down, and both the three.js renderer and the Leaflet maps re-fit live.

Sizes are **not persisted** (per the user's choice) — each page mount starts at
today's defaults, 220px and 320px.

**Branch:** `resizable_windows` already exists and is checked out, with no
commits ahead of `frontend`. No branch creation needed.

There is **no** resize/split-pane dependency in the project and none should be
added — the two handles are ~80 lines of pointer-event code and a dependency
would be the larger change.

## Step 0 — copy this plan into the repo

Following the convention of `OPTIONAL_MESH_PLAN_FRONTEND.md` /
`IMAGE_METADATA_PLAN_FRONTEND.md`, write this document to
`RESIZABLE_WINDOWS_PLAN_FRONTEND.md` at the repo root as the first commit on
the branch.

## Two problems worth naming up front

**1. Leaflet does not notice container resizes.** `grep -rn invalidateSize src`
returns nothing in the whole repo. Leaflet's `trackResize` listens to
`window.resize` only, so a container that changes size on its own leaves the map
with a stale pixel size — grey tile gutters and desynced mouse coordinates. Both
maps need fixing, so this is one shared component (below), not two patches.

The three.js side needs **no** new code: `SplatViewer.jsx:676-679` already
observes `.gv-stage` with a `ResizeObserver` and calls `resizeRenderer()`
(`:518`), which updates `camera.aspect` and `renderer.setSize(w, h, false)`.

**2. `App.css:943` will silently disable the Visualizer splitter.**

```css
@media (max-width: 1100px) {
  .gv-stage-grid { grid-template-columns: 1fr !important; }
}
```

The `!important` exists precisely to beat the inline template, and it should
keep doing so — below 1100px the panes stack and there is nothing to split. The
splitter must therefore *hide itself* at that breakpoint too, or it renders as a
stray 6px grid row.

## Shared pieces (new files)

### `src/hooks/useDragSize.js`

One hook drives both handles. Pointer-events based (`setPointerCapture`, so the
drag survives the pointer leaving the handle — this also keeps events off the
splat canvas, which has pointer-lock camera controls).

```js
useDragSize({ axis, initial, min, max, invert })
// → { size, setSize, handleProps, isDragging }
```

- `axis: 'y' | 'x'` — which coordinate delta counts.
- `min` / `max` accept **a number or a zero-arg function**, evaluated at
  `pointerdown`. The Visualizer needs a container-relative max; the Upload page
  passes plain numbers.
- `invert` — the Visualizer's map pane is on the *right* of its handle, so
  dragging right must *shrink* it. Upload's map is *above* its handle, so
  dragging down grows it (no invert).
- `handleProps` spreads onto the handle element and carries `onPointerDown`,
  `onPointerMove`, `onPointerUp`, `onPointerCancel`, `onKeyDown`,
  `onDoubleClick`, plus `role="separator"`, `tabIndex={0}`, `aria-orientation`,
  and `aria-valuenow/valuemin/valuemax`.
- Keyboard: arrows adjust by 16px (`Shift` → 64px), `Home`/`End` jump to
  min/max. Double-click resets to `initial`.
- While dragging, toggle a `gv-resizing` class on `document.body` so the resize
  cursor persists and text selection is suppressed document-wide. Remove it in
  the pointer-up handler **and** in an effect cleanup, so an unmount mid-drag
  cannot leave the class stuck.

State is local to the hook — no context, no storage, matching the no-persistence
decision.

### `src/components/MapAutoResize.jsx`

A null-rendering react-leaflet child, placed inside each `<MapContainer>`:

```jsx
const map = useMap()
// ResizeObserver on map.getContainer() → rAF → map.invalidateSize({ animate: false })
```

Coalesce through a single `requestAnimationFrame` and skip when the observed
size is unchanged, so a drag does not queue one `invalidateSize` per pointer
event and the ResizeObserver loop cannot recurse. Cancel the frame and
disconnect the observer on cleanup.

This is a genuine bug fix beyond the feature — it also covers window resizes and
the Visualizer's existing "Show map" toggle.

## Upload page — bottom-edge handle

**`src/components/PolygonPicker.jsx`**

- `const { size: mapHeight, handleProps } = useDragSize({ axis: 'y', initial: 220, min: 160, max: 720 })`.
- Put `style={{ height: mapHeight }}` on the existing `.gv-coord-picker-canvas`
  div (`:155-159`) — it keeps its `data-basemap` / `data-editable` attributes and
  its `overflow: hidden`, so the Leaflet dark restyle and cursor rules are
  untouched.
- Add `<MapAutoResize />` inside `<MapContainer>` alongside the existing `<Pane>`
  declarations.
- Render the handle as the **next sibling** of the canvas div, before
  `<details className="gv-coord-layers">`:
  `<div className="gv-resize-handle gv-resize-handle--y" aria-label="Resize map" {...handleProps} />`
- Update the `MAX_PICKER_FEATURES` comment (`:44`), which currently justifies the
  20k cap with "this map is a 220px picker" — the cap stays (it is about feature
  count, not pixels) but the stated reason is now wrong.

Adjacent components need **no** changes: the handle is in normal flow inside
`.gv-coord-picker`, so `.gv-coord-picker-foot`, the layer `<details>`, and the
Photos / Options sections below all shift down naturally.
`.gv-library-lists` is a flex column and `.gv-main` is the scroller
(`App.css:17-21`), so a tall map just extends the page scroll.

**`src/App.css`** — `.gv-coord-picker-canvas` (`:609`): keep `height: 220px` as
the pre-hydration default (the inline style overrides it) and add
`min-height: 160px` so the rule and the hook's floor agree.

## Visualizer page — vertical divider

**`src/components/SplatViewer.jsx`**

- `const { size: mapWidth, handleProps } = useDragSize({ axis: 'x', invert: true, initial: 320, min: 240, max: () => gridRef.current ? gridRef.current.clientWidth * 0.6 : 640 })`
- Add a `gridRef` to the `.gv-stage-grid` div (`:1359`) for that max.
- Replace the inline template (`:1361`):

```jsx
style={{
  gridTemplateColumns: mapOpen
    ? `minmax(0,1fr) 6px min(${mapWidth}px, 60%)`
    : 'minmax(0,1fr)',
}}
```

  The `min(…, 60%)` is belt-and-braces: if the window shrinks after a drag, CSS
  caps the map track without any JS resize listener. The JS max keeps the handle
  under the cursor during the drag itself.

- Between `.gv-stage-panel` and the `{mapOpen ? …}` map panel, render the handle
  under the same `mapOpen` guard:
  `<div className="gv-resize-handle gv-resize-handle--x" aria-label="Resize map panel" {...handleProps} />`

Nothing else on the page changes. The splat pane refits through the existing
`ResizeObserver` at `:678`, the absolutely-positioned overlays
(`.gv-stage-alert`, `.gv-rotate-panel`, `.gv-volume-legend`, `.gv-stage-hint`)
are anchored to `.gv-stage-panel` and follow it, and the toolbar is a separate
grid row.

**`src/components/SplatMap.jsx`** — add `<MapAutoResize />` inside
`<MapContainer>`. Without it the map keeps its mount-time width and greys out
after the first drag. (`MapBuildings` refetches on `moveend`/`zoomend` only;
`invalidateSize` fires those, so buildings re-query correctly for the new
viewport.)

**`src/App.css`** — `.gv-map-panel` currently has no width of its own (the grid
track sizes it), so it needs no change. Add `min-width: 0` if the head/foot
content resists shrinking at the 240px floor.

## `src/App.css` — the handle itself

One shared block, placed **before** the `/* — Leaflet dark restyle — */` section
at `:1666`, which is deliberately last in the file so it beats `leaflet.css`
without `!important`. Do not append after it.

- `.gv-resize-handle` — base: `border: 0`, `background: transparent`,
  `touch-action: none` (required for pointer events on touch),
  `border-radius: var(--radius-sm)`, and a `::after` pseudo-element drawing a
  short centred grip bar in `var(--color-divider)`.
- `.gv-resize-handle--y` — `height: 10px`, `width: 100%`,
  `cursor: ns-resize`; grip bar horizontal, ~48px wide.
- `.gv-resize-handle--x` — `width: 6px`, `height: 100%`,
  `cursor: ew-resize`, `align-self: stretch`; grip bar vertical, ~32px tall.
  Widen the hit area beyond the 6px track with negative-margin padding so it is
  comfortable to grab.
- `:hover`, `:focus-visible`, and `[data-dragging="1"]` brighten the grip to
  `var(--color-accent)`; `:focus-visible` gets a visible outline since the
  handle is keyboard-reachable.
- `body.gv-resizing` — `user-select: none` and `cursor: ns-resize` / `ew-resize`
  (the hook sets a second class per axis) so the cursor does not flicker when
  the pointer strays off the handle mid-drag.
- Inside the existing `@media (max-width: 1100px)` block (`:934`), add
  `.gv-resize-handle--x { display: none; }` — see the gotcha above.
- Inside the existing `@media (max-width: 860px)` block (`:1071`), add
  `.gv-resize-handle--y { display: none; }`, matching how the page already drops
  to a single column on small screens.

## Files touched

| File | Change |
|---|---|
| `RESIZABLE_WINDOWS_PLAN_FRONTEND.md` | new — this plan |
| `src/hooks/useDragSize.js` | new — shared drag hook |
| `src/components/MapAutoResize.jsx` | new — Leaflet `invalidateSize` on container resize |
| `src/components/PolygonPicker.jsx` | height state, bottom handle, `MapAutoResize`, stale comment |
| `src/components/SplatViewer.jsx` | width state, `gridRef`, 3-column template, vertical handle |
| `src/components/SplatMap.jsx` | `MapAutoResize` |
| `src/App.css` | handle styles, `.gv-coord-picker-canvas` floor, two media-query additions |

## Verification

`npm run dev` (Vite, proxies `/api` → `localhost:8000`; the maps and the drag
behaviour work without the backend running — target lists and GIS layers will
just be empty).

**Upload** — `/upload` → "Create new" → "Draw my own":
1. Drag the bar under the map down and up. The map grows/shrinks; the layer
   `<details>`, the foot row, and the Photos/Options sections below move with it.
2. Tiles fill the new area with **no grey gutters**, and a click lands a vertex
   exactly under the cursor at the new size (this is the `invalidateSize` check —
   without it, clicks are offset).
3. Floor and ceiling hold at 160px / 720px.
4. Tab to the handle, arrow keys resize, double-click returns to 220px.

**Visualizer** — `/viewer`, load a splat, click "Show map":
1. Drag the divider both ways. The splat re-renders without stretching or
   letterboxing (`camera.aspect` is being updated) and the map fills its pane
   cleanly.
2. Drag hard right — the map stops at 60% of the row and the splat keeps a
   usable width.
3. Pan/zoom the map after a drag; coordinates and the buildings layer track
   correctly.
4. Start a drag and release the pointer *outside* the window — the drag ends,
   `body.gv-resizing` is gone, and text selection works again.
5. Confirm the drag never triggers the stage's pointer-lock camera look or the
   wheel dolly.
6. Toggle "Hide map" then "Show map" — the panel returns at the width you
   dragged to (state is retained while mounted), and reloading resets it to
   320px.

**Regressions to watch** — narrow the window below 1100px on `/viewer`: panes
stack and the vertical handle disappears. Below 860px on `/upload`: the rail
drops under the form and the horizontal handle disappears. Then
`npm run lint` (the repo has eslint with `react-hooks`; the `min`/`max`
function options must not trip the exhaustive-deps rule — read them from a ref
inside the hook rather than listing them as deps).
