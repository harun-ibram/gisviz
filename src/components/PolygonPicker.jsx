import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import {
  CircleMarker,
  MapContainer,
  Pane,
  Polygon,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'
import {
  EMPTY_POINT,
  isRasterLayer,
  isVectorLayer,
  MAX_POLYGON_VERTICES,
  POINT_RING,
  ringToLatLngs,
  SPLAT_POINT,
} from '../gis/gisGeo.js'
import useDragSize from '../hooks/useDragSize.js'
import { useGisLibrary } from '../hooks/useGisLibrary.js'
import MapAutoResize from './MapAutoResize.jsx'
import GisRasterOverlay from './gis/GisRasterOverlay.jsx'
import GisVectorLayer from './gis/GisVectorLayer.jsx'
import { IconPencil, IconRedo, IconUndo } from './icons.jsx'

/**
 * Show the outline of a target, and — when it is being drawn rather than
 * derived from the photos — let it be drawn by clicking its corners.
 *
 * The ring is kept in API order — [[lon, lat], ...] — and only converted to
 * Leaflet order at the point of rendering, via ringToLatLngs. It is also left
 * open: the server closes it, because a drawing UI has no reason to know that
 * GeoJSON wants the first position repeated at the end.
 *
 * Passing no `onChange` makes the map read-only, which is what the photo-derived
 * sources do: the shape is theirs to compute, and a stray click must not start
 * quietly editing it.
 */

// Six decimals is ~0.1 m, past the point where a click could be more precise.
const PRECISION = 6

// GisMap refuses vector layers past 150k features and asks before 20k. This is
// a picker field, not the GIS workspace, so it just skips the heavy ones — the
// user can resize it, but that does not make it somewhere to inspect 100k roads.
const MAX_PICKER_FEATURES = 20_000

// The picker opens at the height it used to be fixed at. The floor keeps a map
// you can still aim at; the ceiling keeps it from swallowing the whole form.
const HEIGHT_DEFAULT = 220
const HEIGHT_MIN = 160
const HEIGHT_MAX = 720

// Close enough to read a roofline, far enough not to sit inside one building.
const POINT_ZOOM = 17

const noop = () => {}

const round = (value) => Number(value.toFixed(PRECISION))

function ClickToAddVertex({ onAdd }) {
  useMapEvents({
    click: (event) => onAdd([round(event.latlng.lng), round(event.latlng.lat)]),
  })
  return null
}

/**
 * Move the map to whatever is currently being shown.
 *
 * MapContainer reads `center`/`zoom` once, at mount, so without this the map
 * stays parked where it was when the user switches from a drawn ring to a hull
 * across town — the switch would change the answer and show nothing of it.
 *
 * `fitKey` is what says "refit now": fitting on the geometry alone would fight
 * the user for the viewport every time a corner is added.
 */
function FitToShape({ positions, photoPositions, pointPosition, fitKey }) {
  const map = useMap()

  useEffect(() => {
    const all = [...positions, ...photoPositions]

    if (pointPosition) {
      all.push(pointPosition)
    }

    if (all.length === 0) {
      return
    }

    const bounds = L.latLngBounds(all)

    // A lone point gives a zero-area bounds, which fitBounds resolves at
    // maximum zoom over nothing.
    if (all.length === 1 || !bounds.isValid() || bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setView(all[0], POINT_ZOOM)
      return
    }

    map.fitBounds(bounds, { padding: [24, 24], maxZoom: POINT_ZOOM })
    // Deliberately keyed on fitKey alone — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map])

  return null
}

/** Rough centroid, for display only — the server derives the real interior point. */
const centroidOf = (ring) => {
  if (ring.length === 0) return null
  const [lonSum, latSum] = ring.reduce(
    (total, [lon, lat]) => [total[0] + lon, total[1] + lat],
    [0, 0],
  )
  return { lon: lonSum / ring.length, lat: latSum / ring.length }
}

function PolygonPicker({
  value = [],
  onChange,
  point = null,
  photoPoints = [],
  fitKey = '',
}) {
  const editable = typeof onChange === 'function'
  const [basemapId, setBasemapId] = useState('osm')
  const basemap = BASEMAPS[basemapId] ?? BASEMAPS.osm

  // Drag the bar under the map to trade form height for map height. Everything
  // below is in normal flow, so it just moves down.
  const { size: mapHeight, handleProps } = useDragSize({
    axis: 'y',
    initial: HEIGHT_DEFAULT,
    min: HEIGHT_MIN,
    max: HEIGHT_MAX,
  })

  // Same layers and the same visibility the GIS page uses — toggling here
  // toggles there, deliberately: one notion of "which layers am I looking at".
  const { layers, visibleLayerIds, toggleLayerVisibility, opacityByLayer } = useGisLibrary()

  const visible = useMemo(
    () => (layers ?? []).filter((layer) => visibleLayerIds?.includes(layer.layer_id)),
    [layers, visibleLayerIds],
  )
  const rasters = visible.filter(isRasterLayer)
  const vectors = visible.filter(
    (layer) => isVectorLayer(layer) && (layer.feature_count ?? 0) <= MAX_PICKER_FEATURES,
  )
  const skipped = visible.filter(isVectorLayer).length - vectors.length

  const positions = useMemo(() => ringToLatLngs(value), [value])
  // A point list is the same [[lon, lat], ...] shape a ring is, so the one
  // Leaflet-order converter covers both.
  const photoPositions = useMemo(() => ringToLatLngs(photoPoints), [photoPoints])
  const pointPosition = useMemo(
    () => (point ? ringToLatLngs([point])[0] : null),
    [point],
  )
  const centre = useMemo(() => centroidOf(value), [value])

  const addVertex = (vertex) => {
    if (value.length >= MAX_POLYGON_VERTICES) return
    onChange([...value, vertex])
  }

  /**
   * Redo is anchored to the ring it belongs to: `base` is the array identity
   * that was on screen when the stack was last pushed. Any other route to a new
   * ring — a corner added, the source switched back to the photos — leaves
   * `base` behind, and the stack is ignored rather than replaying a shape that
   * no longer follows from what is drawn.
   */
  const [redo, setRedo] = useState({ base: null, stack: [] })
  const canRedo = redo.base === value && redo.stack.length > 0

  const replaceRing = (next) => {
    setRedo({ base: next, stack: [...(redo.base === value ? redo.stack : []), value] })
    onChange(next)
  }

  const redoRing = () => {
    const restored = redo.stack[redo.stack.length - 1]
    setRedo({ base: restored, stack: redo.stack.slice(0, -1) })
    onChange(restored)
  }

  return (
    <div className="gv-gis-map gv-coord-picker">
      <div
        className="gv-coord-picker-canvas"
        data-basemap={basemap.id}
        data-editable={editable ? '1' : '0'}
        style={{ height: mapHeight }}
      >
        <MapContainer
          center={centre ? [centre.lat, centre.lon] : DEFAULT_CENTER}
          zoom={centre ? 15 : DEFAULT_ZOOM}
          className="gv-leaflet"
          scrollWheelZoom
        >
          <TileLayer
            url={basemap.url}
            attribution={basemap.attribution}
            subdomains={basemap.subdomains}
            maxZoom={basemap.maxZoom}
            maxNativeZoom={basemap.maxNativeZoom}
          />
          {/* The map is resizable, and Leaflet only watches the window. */}
          <MapAutoResize />
          {/* Same pane names and z-order GisMap declares — the layer components
              attach to them by name, so they must exist here too. The drawing
              pane sits above both. */}
          <Pane name="gis-raster" style={{ zIndex: 400 }} />
          <Pane name="gis-vector" style={{ zIndex: 450 }} />
          {/* Camera positions sit under the shape they produced, so a dense
              orbit never hides the outline it describes. */}
          <Pane name="photos" style={{ zIndex: 490 }} />
          <Pane name="draw" style={{ zIndex: 500 }} />

          {rasters.map((layer) => (
            <GisRasterOverlay
              key={layer.layer_id}
              layer={layer}
              opacity={opacityByLayer?.[layer.layer_id] ?? 85}
            />
          ))}
          {/* interactive={false}: an interactive path swallows the click before
              the map sees it, which would drop vertices drawn over a layer. */}
          {vectors.map((layer) => (
            <GisVectorLayer
              key={layer.layer_id}
              layer={layer}
              onStatus={noop}
              interactive={false}
            />
          ))}

          {editable ? <ClickToAddVertex onAdd={addVertex} /> : null}

          <FitToShape
            positions={positions}
            photoPositions={photoPositions}
            pointPosition={pointPosition}
            fitKey={fitKey}
          />

          {/* Where the photos were taken. interactive={false} for the same
              reason the vector layers are: a path that takes the click stops a
              corner from landing under it. */}
          {photoPositions.map((position, index) => (
            <CircleMarker
              key={index}
              pane="photos"
              center={position}
              radius={3}
              interactive={false}
              pathOptions={{
                color: POINT_RING,
                weight: 1,
                fillColor: EMPTY_POINT,
                fillOpacity: 0.9,
              }}
            />
          ))}

          {pointPosition ? (
            <CircleMarker
              pane="draw"
              center={pointPosition}
              radius={7}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: SPLAT_POINT,
                fillOpacity: 1,
              }}
            />
          ) : null}

          {/* The ring is drawn closed from three corners on, so there is no
              "click the first vertex to finish" gesture — that would mean
              swallowing a marker click, which eats vertices intermittently. */}
          {value.length >= 3 ? (
            <Polygon
              pane="draw"
              positions={positions}
              pathOptions={{
                color: SPLAT_POINT,
                weight: 2,
                fillColor: SPLAT_POINT,
                fillOpacity: 0.18,
              }}
            />
          ) : null}
          {value.length === 2 ? (
            <Polyline pane="draw" positions={positions}
              pathOptions={{ color: SPLAT_POINT, weight: 2 }} />
          ) : null}

          {positions.map((position, index) => (
            <CircleMarker
              key={index}
              pane="draw"
              center={position}
              // The first corner is drawn larger so the ring's start is legible.
              radius={index === 0 ? 7 : 5}
              pathOptions={{
                color: index === 0 ? '#ffffff' : POINT_RING,
                weight: 2,
                fillColor: SPLAT_POINT,
                fillOpacity: 1,
              }}
            />
          ))}
        </MapContainer>

        {/* Sits over the map, outside .leaflet-container: a click on Undo must
            not also land a corner underneath it. Only for a ring the user owns
            — a photo-derived outline follows the photos instead. */}
        {editable ? (
          <div className="gv-map-dock">
            <span className="gv-map-dock-badge" aria-hidden="true">
              <IconPencil size={14} />
            </span>
            <span className="gv-map-dock-title">Annotation</span>

            <button
              type="button"
              className="gv-map-dock-btn"
              aria-label="Undo last corner"
              title="Undo last corner"
              disabled={value.length === 0}
              onClick={() => replaceRing(value.slice(0, -1))}
            >
              <IconUndo />
            </button>

            <button
              type="button"
              className="gv-map-dock-btn"
              aria-label="Redo"
              title="Redo"
              disabled={!canRedo}
              onClick={redoRing}
            >
              <IconRedo />
            </button>

            <button
              type="button"
              className="gv-map-dock-clear"
              disabled={value.length === 0}
              onClick={() => replaceRing([])}
            >
              Clear
            </button>
          </div>
        ) : null}
      </div>

      <div
        className="gv-resize-handle gv-resize-handle--y"
        aria-label="Resize map"
        {...handleProps}
      />

      {layers?.length ? (
        <details className="gv-coord-layers">
          <summary>
            GIS layers
            <span className="tag tag-neutral">{visible.length}/{layers.length}</span>
          </summary>
          <div className="gv-coord-layer-list">
            {layers.map((layer) => {
              const on = visibleLayerIds?.includes(layer.layer_id)
              const tooHeavy = isVectorLayer(layer)
                && (layer.feature_count ?? 0) > MAX_PICKER_FEATURES
              return (
                <label key={layer.layer_id} className="gv-coord-layer">
                  <input
                    type="checkbox"
                    checked={Boolean(on)}
                    onChange={() => toggleLayerVisibility(layer.layer_id)}
                  />
                  <span className="gv-coord-layer-name">{layer.name}</span>
                  <span className="text-muted">
                    {tooHeavy ? 'too large here' : (layer.kind ?? layer.sublayer ?? layer.layer_type)}
                  </span>
                </label>
              )
            })}
          </div>
          {skipped > 0 ? (
            <p className="text-muted gv-coord-layer-note">
              {skipped} layer{skipped === 1 ? '' : 's'} over {MAX_PICKER_FEATURES.toLocaleString()} features
              {' '}hidden here — open the GIS page to work with them.
            </p>
          ) : null}
        </details>
      ) : null}

      <div className="gv-coord-picker-foot">
        <span className="text-muted">
          {point
            ? `Mean of ${photoPoints.length} photo location${photoPoints.length === 1 ? '' : 's'}`
              + ` · ${point[1].toFixed(5)}, ${point[0].toFixed(5)}`
            : !editable
              ? value.length >= 3
                ? `${value.length} corners around ${photoPoints.length} photo`
                  + `${photoPoints.length === 1 ? '' : 's'}`
                : 'These photos do not describe an area'
              : value.length === 0
                ? 'Click the map to place the first corner'
                : value.length < 3
                  ? `${value.length} corner${value.length === 1 ? '' : 's'} — at least 3 needed`
                  : `${value.length} corners · centre ${centre.lat.toFixed(5)}, ${centre.lon.toFixed(5)}`}
        </span>

        {/* Undo / Redo / Clear moved onto the map itself — see the dock above.
            What is left under it is the choice of basemap, which is about the
            map rather than the shape. */}
        <div className="gv-coord-picker-actions">
          <div className="seg" role="radiogroup" aria-label="Basemap">
            {Object.values(BASEMAPS).map((entry) => (
              <label key={entry.id} className="seg-opt">
                <input
                  type="radio"
                  name="coord-basemap"
                  value={entry.id}
                  checked={entry.id === basemap.id}
                  onChange={() => setBasemapId(entry.id)}
                />
                {entry.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default PolygonPicker
