import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'

/**
 * Pick a point on a map instead of typing it.
 *
 * Two-way with the lat/lon inputs beside it: clicking the map fills them,
 * typing into them moves the marker. Values are strings because they come
 * straight from `<input type="number">`, which yields '' while empty.
 */

// Six decimals is ~0.1 m — past the point where a click could be more precise.
const PRECISION = 6

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
