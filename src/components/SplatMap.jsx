import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import { CircleMarker, MapContainer, Polygon, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { collectCoordinatePairs } from './libraryUtils.jsx'
import { BASEMAPS, DEFAULT_CENTER, DEFAULT_ZOOM } from '../gis/basemaps.js'
import { outerRings } from '../gis/buildings.js'
import {
  EMPTY_POINT,
  NO_DATA_COLOUR,
  POINT_RING,
  ringToLatLngs,
  SPLAT_POINT,
  VOLUME_CLASS_LABELS,
  VOLUME_RAMP_DARK_BG,
} from '../gis/gisGeo.js'
import MapBuildings from './MapBuildings.jsx'

/**
 * The viewer's location map: every node and region on a real basemap, with the
 * ones that already have a splat clickable straight into the viewer.
 *
 * Replaces the hand-rolled SVG minimap, which drew features on a blank
 * parchment square — accurate, but with nothing to locate them against.
 *
 * Targets drawn as polygons show their outline as well as their point. Both,
 * not either: at the zoom that fits a whole library, a 40 m footprint is
 * sub-pixel, so the dot stays the thing you can find and click. The outline is
 * what makes the extent legible once you are zoomed into one.
 */

// Orange for "has a splat you can open", neutral for "nothing generated yet".
// An absence is not a second category, so it gets no hue of its own. Both take
// a dark ring so they stay separable on either basemap and where they overlap.
// Shared with the coordinate picker and mirrored as CSS variables — see gisGeo.

/**
 * One point — and, where one was drawn, one outline — per node/region.
 *
 * The two kinds keep their outline in different columns, because `osm.nodes.geom`
 * is `Point NOT NULL` and cannot be widened: `osm.build_way_geometry()` builds
 * ways out of it with ST_MakeLine. So a node's outline lives in `footprint` and
 * its point in `geom`, while a region carries its outline in `geom` itself and
 * has no separate point. A region created by name before a boundary was drawn
 * has neither, so it is skipped — there is nowhere to put it.
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
    // Empty for anything created before outlines existed, which is the whole
    // back catalogue — those keep rendering as a bare point.
    rings: outerRings(kind === 'node' ? raw?.footprint : raw?.geom),
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
    // Corners as well as centres: fitting to centres alone leaves half of a
    // large drawn area outside the initial view.
    const bounds = L.latLngBounds(features.flatMap((feature) => [
      [feature.lat, feature.lon],
      ...feature.rings.flatMap(ringToLatLngs),
    ]))
    // maxZoom stops a single point from slamming to street level.
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 })
  }, [features, map])

  return null
}

function SplatMap({ className = '' }) {
  const { allNodes, allRegions, loading, error, apiBaseUrl } = useSplatLibrary()
  const navigate = useNavigate()
  const [basemapId, setBasemapId] = useState('dark')
  const [buildings, setBuildings] = useState(null)

  // Stable, or the building layer's fetch effect re-runs on every parent render.
  const handleBuildings = useCallback((status) => setBuildings(status), [])

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
  const withOutline = features.filter((feature) => feature.rings.length > 0).length

  // Buildings are fetched for the viewport, not the library, so their state is
  // reported separately — "nothing here" and "you are too far out" are
  // different answers and only one of them is worth acting on.
  const buildingNote = (() => {
    if (!buildings) return null
    if (buildings.kind === 'zoom') return 'zoom in for building heights'
    if (buildings.kind === 'error') return `buildings unavailable — ${buildings.message}`
    if (buildings.shown === 0) return 'no buildings measured here'
    const clipped = buildings.total > buildings.shown ? ` of ${buildings.total}` : ''
    return `${buildings.measured}/${buildings.shown}${clipped} buildings with a LiDAR height`
  })()

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

          {/* Buildings first of all: they are the ground layer, and both the
              drawn outline and the dots have to stay readable on top. */}
          <MapBuildings apiBaseUrl={apiBaseUrl} onStatus={handleBuildings} />

          {/* Outlines before markers, deliberately. Both are SVG paths in the
              same overlay pane, where paint order is DOM order — so mounting
              these first keeps every dot clickable on top of its own outline
              instead of buried under a fill that also wants the click. */}
          {ordered.flatMap((feature) => {
            const openable = Boolean(feature.modelPath)
            const colour = openable ? SPLAT_POINT : EMPTY_POINT
            return feature.rings.map((ring, index) => (
              <Polygon
                key={`${feature.key}-outline-${index}`}
                positions={ringToLatLngs(ring)}
                className={openable ? 'gv-splat-point--open' : 'gv-splat-point'}
                pathOptions={{
                  color: colour,
                  weight: 2,
                  // Low enough to read the basemap through — the outline is
                  // the signal, the fill only says which side is inside.
                  fillColor: colour,
                  fillOpacity: 0.16,
                }}
                eventHandlers={{ click: () => open(feature) }}
              />
            ))
          })}

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
                  {feature.rings.length > 0 ? (
                    <>
                      {' · '}
                      {feature.rings.reduce((total, ring) => total + ring.length, 0)} corners
                    </>
                  ) : null}
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
          {withOutline > 0 ? (
            <span className="map-key-item">
              <i className="map-key-dot map-key-dot--area" aria-hidden="true" />
              drawn area
            </span>
          ) : null}
        </div>

        {buildings?.kind === 'ok' && buildings.shown > 0 ? (
          <div className="map-key map-key--volume">
            <span className="map-key-label">volume</span>
            {VOLUME_CLASS_LABELS.map((label, index) => (
              // Swatch only, no caption: four labels would wrap this strip onto
              // three lines under a sidebar map. The title carries the class.
              <span key={label} className="map-key-item" title={label} aria-label={label}>
                <i
                  className="map-key-swatch"
                  style={{ background: VOLUME_RAMP_DARK_BG[index] }}
                  aria-hidden="true"
                />
              </span>
            ))}
            <span className="map-key-item">
              <i
                className="map-key-swatch"
                style={{ background: NO_DATA_COLOUR, opacity: 0.5 }}
                aria-hidden="true"
              />
              no LiDAR
            </span>
          </div>
        ) : null}

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
              // The outline count is here on purpose: when nothing is outlined,
              // this is what distinguishes "the map is broken" from "these
              // targets predate drawn outlines".
              : `${withSplat} of ${features.length} with a splat · ${withOutline} outlined`}
        {buildingNote ? <><br />{buildingNote}</> : null}
      </p>
    </div>
  )
}

export default SplatMap
