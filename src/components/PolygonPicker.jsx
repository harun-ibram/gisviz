import { useMemo, useState } from 'react'
import {
  CircleMarker,
  MapContainer,
  Pane,
  Polygon,
  Polyline,
  TileLayer,
  useMapEvents,
} from 'react-leaflet'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'
import {
  isRasterLayer,
  isVectorLayer,
  POINT_RING,
  ringToLatLngs,
  SPLAT_POINT,
} from '../gis/gisGeo.js'
import { useGisLibrary } from '../hooks/useGisLibrary.js'
import GisRasterOverlay from './gis/GisRasterOverlay.jsx'
import GisVectorLayer from './gis/GisVectorLayer.jsx'

/**
 * Draw the outline of a target by clicking its corners.
 *
 * The ring is kept in API order — [[lon, lat], ...] — and only converted to
 * Leaflet order at the point of rendering, via ringToLatLngs. It is also left
 * open: the server closes it, because a drawing UI has no reason to know that
 * GeoJSON wants the first position repeated at the end.
 */

// Six decimals is ~0.1 m, past the point where a click could be more precise.
const PRECISION = 6

// Matches MAX_POLYGON_VERTICES on the server, so the limit is felt while
// drawing rather than reported after a failed submit.
const MAX_VERTICES = 1000

// GisMap refuses vector layers past 150k features and asks before 20k. This map
// is a 220px picker, not the GIS workspace, so it just skips the heavy ones.
const MAX_PICKER_FEATURES = 20_000

const noop = () => {}

const round = (value) => Number(value.toFixed(PRECISION))

function ClickToAddVertex({ onAdd }) {
  useMapEvents({
    click: (event) => onAdd([round(event.latlng.lng), round(event.latlng.lat)]),
  })
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

function PolygonPicker({ value = [], onChange }) {
  const [basemapId, setBasemapId] = useState('osm')
  const basemap = BASEMAPS[basemapId] ?? BASEMAPS.osm

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
  const centre = useMemo(() => centroidOf(value), [value])

  const addVertex = (point) => {
    if (value.length >= MAX_VERTICES) return
    onChange([...value, point])
  }

  return (
    <div className="gv-gis-map gv-coord-picker">
      <div className="gv-coord-picker-canvas" data-basemap={basemap.id}>
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
          {/* Same pane names and z-order GisMap declares — the layer components
              attach to them by name, so they must exist here too. The drawing
              pane sits above both. */}
          <Pane name="gis-raster" style={{ zIndex: 400 }} />
          <Pane name="gis-vector" style={{ zIndex: 450 }} />
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

          <ClickToAddVertex onAdd={addVertex} />

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
      </div>

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
          {value.length === 0
            ? 'Click the map to place the first corner'
            : value.length < 3
              ? `${value.length} corner${value.length === 1 ? '' : 's'} — at least 3 needed`
              : `${value.length} corners · centre ${centre.lat.toFixed(5)}, ${centre.lon.toFixed(5)}`}
        </span>

        <div className="gv-coord-picker-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={value.length === 0}
            onClick={() => onChange(value.slice(0, -1))}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={value.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>

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
