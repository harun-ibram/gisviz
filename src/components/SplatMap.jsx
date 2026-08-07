import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { collectCoordinatePairs } from './libraryUtils.jsx'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'

/**
 * The viewer's location map: every node and region on a real basemap, with the
 * ones that already have a splat clickable straight into the viewer.
 *
 * Replaces the hand-rolled SVG minimap, which drew features on a blank
 * parchment square — accurate, but with nothing to locate them against.
 * Heights from LiDAR are the intended next step; points come first.
 */

// Orange for "has a splat you can open", neutral for "nothing generated yet".
// An absence is not a second category, so it gets no hue of its own. Both take
// a dark ring so they stay separable on either basemap and where they overlap.
const SPLAT_POINT = '#eb6834'
const EMPTY_POINT = '#b3a68f'
const POINT_RING = '#111722'

/**
 * One point per node/region.
 *
 * Nodes carry a GeoJSON Point; regions a MultiPolygon, or null when one was
 * created by name before a boundary was drawn. Both collapse to a single
 * lon/lat, and a region with no geometry has nowhere to sit, so it is skipped.
 */
const toMapFeature = (kind, raw) => {
  const pairs = collectCoordinatePairs(raw?.geom?.coordinates)
  if (pairs.length === 0) return null

  const [lonSum, latSum] = pairs.reduce(
    (total, [lon, lat]) => [total[0] + lon, total[1] + lat],
    [0, 0],
  )

  return {
    key: `${kind}-${kind === 'node' ? raw.node_id : raw.id}`,
    kind,
    name: kind === 'node' ? (raw.tags?.name ?? `Node ${raw.node_id}`) : (raw.name ?? 'Region'),
    lon: lonSum / pairs.length,
    lat: latSum / pairs.length,
    modelPath: raw.model_path ?? null,
  }
}

// Note: no `preferCanvas` on the map below, unlike the GIS page. The canvas
// renderer paints every CircleMarker into one <canvas>, which is what makes 48k
// features viable there — but it leaves no DOM node per marker, so `className`
// (and the pointer cursor it carries) never lands. A handful of splat points is
// far better served by real SVG paths.

/** Frame the features once they are known; Leaflet cannot do this declaratively. */
function FitToFeatures({ features }) {
  const map = useMap()

  useEffect(() => {
    if (features.length === 0) return
    const bounds = L.latLngBounds(features.map((feature) => [feature.lat, feature.lon]))
    // maxZoom stops a single point from slamming to street level.
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 })
  }, [features, map])

  return null
}

function SplatMap({ className = '' }) {
  const { allNodes, allRegions, loading, error } = useSplatLibrary()
  const navigate = useNavigate()
  const [basemapId, setBasemapId] = useState('dark')

  const features = useMemo(() => [
    ...(allNodes ?? []).map((node) => toMapFeature('node', node)),
    ...(allRegions ?? []).map((region) => toMapFeature('region', region)),
  ].filter(Boolean), [allNodes, allRegions])

  // Splat-bearing points render last so they sit on top where features overlap.
  const ordered = useMemo(
    () => [...features].sort((a, b) => Number(Boolean(a.modelPath)) - Number(Boolean(b.modelPath))),
    [features],
  )

  const basemap = BASEMAPS[basemapId] ?? BASEMAPS.dark
  const withSplat = features.filter((feature) => feature.modelPath).length

  const open = (feature) => {
    if (!feature.modelPath) return
    // Same state shape Home.jsx uses, so the viewer's existing effect picks it up.
    navigate('/viewer', { state: { modelPath: feature.modelPath, name: feature.name } })
  }

  return (
    <div className={`gv-gis-map gv-splat-map ${className}`.trim()}>
      <div className="gv-splat-map-canvas" data-basemap={basemap.id}>
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
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

          <FitToFeatures features={features} />

          {ordered.map((feature) => {
            const openable = Boolean(feature.modelPath)
            return (
              <CircleMarker
                key={feature.key}
                center={[feature.lat, feature.lon]}
                radius={openable ? 8 : 6}
                // className is a top-level prop, not a pathOption: react-leaflet
                // applies pathOptions through setStyle, while Leaflet only reads
                // className once, when it creates the <path>. Inside pathOptions
                // it is silently dropped.
                className={openable ? 'gv-splat-point gv-splat-point--open' : 'gv-splat-point'}
                pathOptions={{
                  color: POINT_RING,
                  weight: 2,
                  fillColor: openable ? SPLAT_POINT : EMPTY_POINT,
                  fillOpacity: 1,
                }}
                eventHandlers={{ click: () => open(feature) }}
              >
                <Tooltip direction="top" offset={[0, -8]}>
                  <strong>{feature.name}</strong>
                  <br />
                  {feature.kind === 'node' ? 'Node' : 'Region'}
                  {' · '}
                  {feature.lat.toFixed(5)}, {feature.lon.toFixed(5)}
                  <br />
                  {openable ? 'Click to open this splat' : 'No splat generated yet'}
                </Tooltip>
              </CircleMarker>
            )
          })}
        </MapContainer>
      </div>

      <div className="gv-splat-map-foot">
        <div className="map-key">
          <span className="map-key-item">
            <i className="map-key-dot map-key-dot--splat" aria-hidden="true" />
            splat — click to open
          </span>
          <span className="map-key-item">
            <i className="map-key-dot map-key-dot--empty" aria-hidden="true" />
            no splat yet
          </span>
        </div>

        {/* Same label-wrapping-radio markup the GIS page uses, so it picks up
            the existing .seg styling rather than needing its own. */}
        <div className="seg" role="radiogroup" aria-label="Basemap">
          {Object.values(BASEMAPS).map((entry) => (
            <label key={entry.id} className="seg-opt">
              <input
                type="radio"
                name="splat-basemap"
                value={entry.id}
                checked={entry.id === basemap.id}
                onChange={() => setBasemapId(entry.id)}
              />
              {entry.label}
            </label>
          ))}
        </div>
      </div>

      <p className="map-caption">
        {error
          ? error
          : loading
            ? 'Loading map…'
            : features.length === 0
              ? 'Nothing on the map yet — add a node or a region first.'
              : `${withSplat} of ${features.length} with a splat`}
      </p>
    </div>
  )
}

export default SplatMap
