import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Pane, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'
import { isRasterLayer, isVectorLayer } from '../gis/gisGeo.js'
import { useGisLibrary } from '../hooks/useGisLibrary.js'
import GisRasterOverlay from './gis/GisRasterOverlay.jsx'
import GisVectorLayer from './gis/GisVectorLayer.jsx'

/**
 * Pick a point on a map instead of typing it.
 *
 * Two-way with the lat/lon inputs beside it: clicking the map fills them,
 * typing into them moves the marker. Values are strings because they come
 * straight from `<input type="number">`, which yields '' while empty.
 */

// Six decimals is ~0.1 m — past the point where a click could be more precise.
const PRECISION = 6

// GisMap refuses vector layers past 150k features and asks before 20k. This map
// is a 220px picker, not the GIS workspace, so it just skips the heavy ones —
// they are unusable at this size and would stall the click handler.
const MAX_PICKER_FEATURES = 20_000

const noop = () => {}

const round = (value) => Number(value.toFixed(PRECISION))

function ClickToPick({ onPick }) {
  useMapEvents({
    click: (event) => onPick(round(event.latlng.lat), round(event.latlng.lng)),
  })
  return null
}

function FollowTyped({ point }) {
  const map = useMap()

  useEffect(() => {
    if (!point) return
    // Only chase the typed value when it has gone off-screen. Recentring on
    // every keystroke would fight the user as they pan or type digit by digit.
    if (map.getBounds().contains([point.lat, point.lon])) return
    map.setView([point.lat, point.lon], Math.max(map.getZoom(), 13))
  }, [point, map])

  return null
}

function CoordinatePicker({ lat, lon, onPick }) {
  const [basemapId, setBasemapId] = useState('osm')
  const basemap = BASEMAPS[basemapId] ?? BASEMAPS.osm

  // Same layers and the same visibility the GIS page uses — toggling here
  // toggles there, deliberately: one notion of "which layers am I looking at".
  const {
    layers,
    visibleLayerIds,
    toggleLayerVisibility,
    opacityByLayer,
  } = useGisLibrary()

  const visible = useMemo(
    () => (layers ?? []).filter((layer) => visibleLayerIds?.includes(layer.layer_id)),
    [layers, visibleLayerIds],
  )
  const rasters = visible.filter(isRasterLayer)
  const vectors = visible.filter(
    (layer) => isVectorLayer(layer) && (layer.feature_count ?? 0) <= MAX_PICKER_FEATURES,
  )
  const skipped = visible.filter(isVectorLayer).length - vectors.length

  const point = useMemo(() => {
    const parsedLat = Number.parseFloat(lat)
    const parsedLon = Number.parseFloat(lon)
    return Number.isFinite(parsedLat) && Number.isFinite(parsedLon)
      ? { lat: parsedLat, lon: parsedLon }
      : null
  }, [lat, lon])

  return (
    <div className="gv-gis-map gv-coord-picker">
      <div className="gv-coord-picker-canvas" data-basemap={basemap.id}>
        <MapContainer
          center={point ? [point.lat, point.lon] : DEFAULT_CENTER}
          zoom={point ? 15 : DEFAULT_ZOOM}
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
              attach to them by name, so they must exist here too. */}
          <Pane name="gis-raster" style={{ zIndex: 400 }} />
          <Pane name="gis-vector" style={{ zIndex: 450 }} />

          {rasters.map((layer) => (
            <GisRasterOverlay
              key={layer.layer_id}
              layer={layer}
              opacity={opacityByLayer?.[layer.layer_id] ?? 85}
            />
          ))}
          {vectors.map((layer) => (
            <GisVectorLayer key={layer.layer_id} layer={layer} onStatus={noop} />
          ))}

          <ClickToPick onPick={onPick} />
          <FollowTyped point={point} />
          {point ? (
            <CircleMarker
              center={[point.lat, point.lon]}
              radius={8}
              pathOptions={{ color: '#111722', weight: 2, fillColor: '#eb6834', fillOpacity: 1 }}
            />
          ) : null}
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
          {point ? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` : 'Click the map to set coordinates'}
        </span>

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
  )
}

export default CoordinatePicker
