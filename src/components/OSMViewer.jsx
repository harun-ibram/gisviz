import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { collectCoordinatePairs } from './libraryUtils.jsx'

const svgSize = 1000
const svgPadding = 74

const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'

// One degree of latitude is this many metres everywhere; longitude shrinks by
// cos(latitude), which is what makeProjector corrects for.
const METRES_PER_DEGREE_LAT = 111320

// How much of the map the tallest building may occupy, and the least it may
// occupy before the extrusion stops reading as height at all.
const MAX_LIFT_FRACTION = 0.18
const MIN_LIFT_FRACTION = 0.06

/**
 * One vertical multiplier for the whole scene.
 *
 * A fixed exaggeration cannot work at both zooms: over a 300 m block a 48 m
 * building is already ~14% of the map at true scale, and multiplying that by a
 * constant turns the map into bar charts; over a whole city true scale makes
 * every building a hairline. So: stay at 1 (honest) whenever true scale lands in
 * a readable band, and only depart from it to pull the tallest building back
 * under the ceiling or up over the floor. Footprints are never touched, and the
 * legend reports whatever factor came out.
 */
const verticalScale = (maxHeightM, pxPerMetre) => {
  const inner = svgSize - svgPadding * 2
  const trueLift = maxHeightM * pxPerMetre
  if (!(trueLift > 0)) return 1
  if (trueLift > inner * MAX_LIFT_FRACTION) return (inner * MAX_LIFT_FRACTION) / trueLift
  if (trueLift < inner * MIN_LIFT_FRACTION) return (inner * MIN_LIFT_FRACTION) / trueLift
  return 1
}

// Sequential ramp for volume: one blue hue, light -> dark, four classes.
// Steps 400/500/600/700 of the blue ramp, chosen against this map's parchment
// surface (#e8d8c0) rather than a white one — the lighter steps that pass on
// white drop under the 2:1 contrast floor on tan. Walls take a darker step of
// the same hue so each building reads as one solid mass.
const VOLUME_RAMP = [
  { roof: '#3987e5', wall: '#1c5cab' },
  { roof: '#256abf', wall: '#104281' },
  { roof: '#184f95', wall: '#0d366b' },
  { roof: '#0d366b', wall: '#0a2b57' },
]

// Deliberately off-ramp and desaturated: a footprint the LiDAR never covered is
// not "zero volume", and must not read as the bottom class.
const NO_DATA_FILL = { roof: '#a8a49a', wall: '#8b877d' }

const formatVolume = (value) => {
  if (value === null || value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M m³`
  if (value >= 1000) return `${Math.round(value / 1000)}k m³`
  return `${Math.round(value)} m³`
}

const formatMetres = (value) =>
  value === null || value === undefined ? '—' : `${value.toFixed(1)} m`

/** Outer rings only — holes do not survive an extrusion usefully. */
const outerRings = (geometry) => {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((part) => part[0])
  return []
}

const volumeOf = (properties) =>
  properties?.volume_lidar_m3 ?? properties?.volume_prism_m3 ?? null

/**
 * Class breaks at the quartiles of the data actually present, rather than fixed
 * thresholds — a village and a city centre otherwise collapse into one class.
 */
const volumeBreaks = (volumes) => {
  const sorted = volumes.filter((v) => v !== null && v > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return [at(0.25), at(0.5), at(0.75)]
}

const classOf = (volume, breaks) => {
  if (volume === null || breaks === null) return null
  if (volume <= breaks[0]) return 0
  if (volume <= breaks[1]) return 1
  if (volume <= breaks[2]) return 2
  return 3
}

// Round numbers a scale bar is allowed to land on.
const SCALE_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]

// Map features (nodes and regions). Orange for "has a splat you can open",
// neutral for "nothing generated yet" — an absence is not a second category, so
// it gets no hue of its own. Both carry a dark ring so they stay separable
// against the parchment and against each other where they overlap.
const SPLAT_POINT = '#eb6834'
const EMPTY_POINT = '#b3a68f'
const POINT_RING = '#243041'

/**
 * One clickable dot per node/region.
 *
 * Nodes carry a GeoJSON Point; regions carry a MultiPolygon, or null when one
 * was created by name before a boundary was drawn. Both collapse to a single
 * lon/lat here — the plan is points now, extruded LiDAR heights later — and a
 * region without geometry simply has nowhere to sit, so it is skipped.
 */
const toMapFeature = (kind, raw) => {
  const pairs = collectCoordinatePairs(raw?.geom?.coordinates)
  if (pairs.length === 0) return null

  const [lonSum, latSum] = pairs.reduce(
    (total, [lon, lat]) => [total[0] + lon, total[1] + lat],
    [0, 0],
  )
  const lon = lonSum / pairs.length
  const lat = latSum / pairs.length

  const name = kind === 'node'
    ? (raw.tags?.name ?? `Node ${raw.node_id}`)
    : (raw.name ?? 'Region')

  return {
    key: `${kind}-${kind === 'node' ? raw.node_id : raw.id}`,
    kind,
    name,
    lon,
    lat,
    modelPath: raw.model_path ?? null,
  }
}

const interestingNodeTags = ['name', 'amenity', 'tourism', 'historic', 'shop', 'office', 'entrance', 'highway', 'barrier', 'railway', 'man_made', 'leisure']

const getTagValue = (tags, keys) => {
  for (const key of keys) {
    if (tags[key]) {
      return tags[key]
    }
  }

  return ''
}

const parseTags = (element) => {
  const tags = {}

  element.querySelectorAll('tag').forEach((tagElement) => {
    const key = tagElement.getAttribute('k')
    const value = tagElement.getAttribute('v')

    if (key && value) {
      tags[key] = value
    }
  })

  return tags
}

const parseOsm = (xmlText) => {
  const parser = new DOMParser()
  const xml = parser.parseFromString(xmlText, 'application/xml')
  const parserError = xml.querySelector('parsererror')

  if (parserError) {
    throw new Error('Unable to parse map.osm')
  }

  const boundsElement = xml.querySelector('bounds')
  const bounds = boundsElement
    ? {
        minLat: Number(boundsElement.getAttribute('minlat')),
        minLon: Number(boundsElement.getAttribute('minlon')),
        maxLat: Number(boundsElement.getAttribute('maxlat')),
        maxLon: Number(boundsElement.getAttribute('maxlon')),
      }
    : null

  const nodes = new Map()

  xml.querySelectorAll('node').forEach((nodeElement) => {
    const id = nodeElement.getAttribute('id')
    const lat = Number(nodeElement.getAttribute('lat'))
    const lon = Number(nodeElement.getAttribute('lon'))

    if (!id || Number.isNaN(lat) || Number.isNaN(lon)) {
      return
    }

    nodes.set(id, {
      id,
      lat,
      lon,
      tags: parseTags(nodeElement),
    })
  })

  const ways = []

  xml.querySelectorAll('way').forEach((wayElement) => {
    const id = wayElement.getAttribute('id')

    if (!id) {
      return
    }

    const refs = Array.from(wayElement.querySelectorAll('nd'))
      .map((ndElement) => ndElement.getAttribute('ref'))
      .filter(Boolean)

    if (refs.length < 2) {
      return
    }

    ways.push({
      id,
      refs,
      tags: parseTags(wayElement),
    })
  })

  const derivedBounds = bounds ?? (() => {
    const nodeValues = Array.from(nodes.values())

    return nodeValues.reduce(
      (accumulator, node) => ({
        minLat: Math.min(accumulator.minLat, node.lat),
        minLon: Math.min(accumulator.minLon, node.lon),
        maxLat: Math.max(accumulator.maxLat, node.lat),
        maxLon: Math.max(accumulator.maxLon, node.lon),
      }),
      {
        minLat: Number.POSITIVE_INFINITY,
        minLon: Number.POSITIVE_INFINITY,
        maxLat: Number.NEGATIVE_INFINITY,
        maxLon: Number.NEGATIVE_INFINITY,
      },
    )
  })()

  return {
    bounds: derivedBounds,
    nodes,
    ways,
  }
}

/**
 * Equirectangular projection that is actually to scale.
 *
 * Two fixes over stretching each axis to fill the box independently:
 *   * longitude is multiplied by cos(latitude), because a degree of longitude
 *     covers less ground the further you are from the equator — without this
 *     everything is stretched horizontally (~40% at 45°N);
 *   * both axes share ONE scale factor and the result is centred, so a square
 *     building renders square instead of being squashed to the viewport's
 *     aspect ratio.
 *
 * Returns the projector plus `pxPerMetre`, which the extrusion and the scale
 * bar both need.
 */
const makeProjector = (bounds) => {
  const midLat = (bounds.minLat + bounds.maxLat) / 2
  const lonShrink = Math.cos((midLat * Math.PI) / 180)

  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.000001)
  const lonSpan = Math.max((bounds.maxLon - bounds.minLon) * lonShrink, 0.000001)

  const innerSize = svgSize - svgPadding * 2
  const scale = innerSize / Math.max(latSpan, lonSpan) // px per degree of latitude
  const offsetX = svgPadding + (innerSize - lonSpan * scale) / 2
  const offsetY = svgPadding + (innerSize - latSpan * scale) / 2

  const project = (lat, lon) => ({
    x: offsetX + (lon - bounds.minLon) * lonShrink * scale,
    y: offsetY + (bounds.maxLat - lat) * scale,
  })

  project.pxPerMetre = scale / METRES_PER_DEGREE_LAT
  return project
}

/** A round distance that fits in roughly a fifth of the map, plus its pixel width. */
const makeScaleBar = (pxPerMetre) => {
  const target = (svgSize - svgPadding * 2) / 5 / pxPerMetre
  const metres = SCALE_STEPS.find((step) => step >= target) ?? SCALE_STEPS[SCALE_STEPS.length - 1]
  return { metres, width: metres * pxPerMetre }
}

const getWayStyle = (tags) => {
  if (tags.highway) {
    const road = tags.highway

    if (road === 'motorway' || road === 'trunk') {
      return { stroke: '#ffd36f', strokeWidth: 14 }
    }

    if (road === 'primary' || road === 'secondary') {
      return { stroke: '#f2c89a', strokeWidth: 10 }
    }

    if (road === 'tertiary' || road === 'residential' || road === 'unclassified') {
      return { stroke: '#fff8ea', strokeWidth: 6 }
    }

    return { stroke: '#f6e8d4', strokeWidth: 4 }
  }

  if (tags.railway) {
    return { stroke: '#9fb2cf', strokeWidth: 3, dashArray: '12 10' }
  }

  if (tags.waterway || tags.natural === 'water') {
    return { stroke: '#4f9df0', strokeWidth: 4, fill: '#4f9df022' }
  }

  if (tags.building) {
    return { stroke: '#445264', strokeWidth: 1.4, fill: '#5d6a7f88' }
  }

  if (tags.landuse || tags.leisure) {
    return { stroke: '#8ea37f', strokeWidth: 1.2, fill: '#6f9c5d33' }
  }

  return { stroke: '#aab6c7', strokeWidth: 1.5 }
}

const getNodeLabel = (tags) => {
  const label = getTagValue(tags, ['name', 'amenity', 'tourism', 'historic', 'shop', 'office', 'entrance', 'highway', 'barrier'])

  if (!label) {
    return ''
  }

  return label.replaceAll(';', ' · ')
}

const nodePriority = (tags) => {
  if (tags.name) return 5
  if (tags.amenity || tags.tourism || tags.historic) return 4
  if (tags.shop || tags.office || tags.leisure) return 3
  if (tags.entrance || tags.highway || tags.barrier) return 2
  return 1
}

/**
 * Parse OSM XML if any was supplied. This used to run at module load against a
 * hardcoded empty string, which always threw — so the map rendered nothing at
 * all. It is now driven by the optional `osmText` prop: pass a map.osm to get
 * the road/water/landuse context back, or leave it out for buildings only.
 */
const parseOsmText = (osmText) => {
  if (!osmText || typeof DOMParser === 'undefined') {
    return { data: null, error: '' }
  }
  try {
    return { data: parseOsm(osmText), error: '' }
  } catch (parseError) {
    return {
      data: null,
      error: parseError instanceof Error ? parseError.message : 'Unable to read map.osm',
    }
  }
}

function OSMViewer({ className = 'map-card', osmText = null, bbox = null } = {}) {
  // One state object, written only from the fetch callbacks. Resetting to
  // "loading" synchronously at the top of the effect would be a cascading
  // render, so a bbox change keeps showing the previous result until the new
  // one lands — which also avoids a blank flash on every pan.
  const [request, setRequest] = useState({ status: 'loading', data: null, error: '' })
  const [hovered, setHovered] = useState(null)
  const [hoveredFeature, setHoveredFeature] = useState(null)
  const navigate = useNavigate()

  // Every node and region, not only the ones with a splat: the map is meant to
  // show what exists and which of it is already reconstructed.
  const { allNodes, allRegions } = useSplatLibrary()

  const features = useMemo(() => [
    ...(allNodes ?? []).map((node) => toMapFeature('node', node)),
    ...(allRegions ?? []).map((region) => toMapFeature('region', region)),
  ].filter(Boolean), [allNodes, allRegions])

  useEffect(() => {
    let active = true
    const query = new URLSearchParams({ limit: '4000' })
    if (bbox) {
      query.set('bbox', bbox)
    }

    fetch(`${apiBaseUrl}/gis/buildings?${query}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load buildings (${response.status})`)
        }
        return response.json()
      })
      .then((collection) => {
        if (!active) return
        setRequest({
          status: 'ready',
          error: '',
          data: {
            features: collection.features ?? [],
            total: collection.total ?? 0,
            returned: collection.returned ?? 0,
          },
        })
      })
      .catch((error) => {
        if (!active) return
        setRequest({
          status: 'error',
          data: null,
          error: error instanceof Error ? error.message : 'Unable to load buildings.',
        })
      })

    return () => {
      active = false
    }
  }, [bbox])

  const buildings = request.data
  const loading = request.status === 'loading'
  const fetchError = request.error

  const { data: mapData, error: parseError } = useMemo(() => parseOsmText(osmText), [osmText])

  // Both layers share one projection, computed over whatever is on screen.
  const bounds = useMemo(() => {
    const box = {
      minLat: Number.POSITIVE_INFINITY,
      minLon: Number.POSITIVE_INFINITY,
      maxLat: Number.NEGATIVE_INFINITY,
      maxLon: Number.NEGATIVE_INFINITY,
    }
    let seen = false

    for (const feature of buildings?.features ?? []) {
      for (const ring of outerRings(feature.geometry)) {
        for (const [lon, lat] of ring) {
          box.minLat = Math.min(box.minLat, lat)
          box.maxLat = Math.max(box.maxLat, lat)
          box.minLon = Math.min(box.minLon, lon)
          box.maxLon = Math.max(box.maxLon, lon)
          seen = true
        }
      }
    }
    for (const feature of features) {
      box.minLat = Math.min(box.minLat, feature.lat)
      box.maxLat = Math.max(box.maxLat, feature.lat)
      box.minLon = Math.min(box.minLon, feature.lon)
      box.maxLon = Math.max(box.maxLon, feature.lon)
      seen = true
    }
    if (mapData) {
      box.minLat = Math.min(box.minLat, mapData.bounds.minLat)
      box.maxLat = Math.max(box.maxLat, mapData.bounds.maxLat)
      box.minLon = Math.min(box.minLon, mapData.bounds.minLon)
      box.maxLon = Math.max(box.maxLon, mapData.bounds.maxLon)
      seen = true
    }
    if (!seen) return null

    // A single point, or several at the same spot, gives a zero-span box that
    // the projector would divide by. Open it out to roughly a 200 m window.
    const PAD = 0.001
    if (box.maxLat - box.minLat < PAD) {
      const midLat = (box.minLat + box.maxLat) / 2
      box.minLat = midLat - PAD
      box.maxLat = midLat + PAD
    }
    if (box.maxLon - box.minLon < PAD) {
      const midLon = (box.minLon + box.maxLon) / 2
      box.minLon = midLon - PAD
      box.maxLon = midLon + PAD
    }
    return box
  }, [buildings, mapData, features])

  const project = useMemo(() => (bounds ? makeProjector(bounds) : null), [bounds])

  const buildingView = useMemo(() => {
    if (!project || !buildings?.features?.length) {
      return null
    }

    const breaks = volumeBreaks(buildings.features.map((f) => volumeOf(f.properties)))
    const maxHeight = buildings.features.reduce(
      (tallest, f) => Math.max(tallest, f.properties?.height_m ?? 0),
      0,
    )
    const liftScale = verticalScale(maxHeight, project.pxPerMetre)
    const shapes = []

    for (const feature of buildings.features) {
      const properties = feature.properties ?? {}
      const volume = volumeOf(properties)
      const height = properties.height_m
      const measured = height !== null && height !== undefined
      const palette = measured ? VOLUME_RAMP[classOf(volume, breaks) ?? 0] : NO_DATA_FILL
      const lift = measured ? height * project.pxPerMetre * liftScale : 0

      for (const [index, ring] of outerRings(feature.geometry).entries()) {
        const base = ring.map(([lon, lat]) => project(lat, lon))
        if (base.length < 3) continue

        const roof = base.map((point) => ({ x: point.x, y: point.y - lift }))
        const toPath = (points) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

        // Walls as one quad per edge. Drawn before the roof, so the roof caps
        // the solid and the back walls are hidden behind it.
        const walls = []
        if (lift > 0.5) {
          for (let i = 0; i < base.length - 1; i += 1) {
            walls.push(toPath([base[i], base[i + 1], roof[i + 1], roof[i]]))
          }
        }

        shapes.push({
          key: `${feature.id ?? properties.osm_id ?? 'b'}-${index}`,
          feature,
          properties,
          measured,
          palette,
          walls,
          roofPath: toPath(roof),
          basePath: toPath(base),
          // Painter's algorithm: southernmost point decides draw order, so
          // nearer buildings land on top of the ones behind them.
          sortLat: Math.min(...ring.map(([, lat]) => lat)),
        })
      }
    }

    // Far (north, higher latitude) first.
    shapes.sort((a, b) => b.sortLat - a.sortLat)

    const measuredCount = buildings.features.filter(
      (f) => f.properties?.height_m !== null && f.properties?.height_m !== undefined,
    ).length

    return {
      shapes,
      breaks,
      measuredCount,
      liftScale,
      scaleBar: makeScaleBar(project.pxPerMetre),
      totalVolume: buildings.features.reduce((sum, f) => sum + (volumeOf(f.properties) ?? 0), 0),
    }
  }, [buildings, project])

  const featureView = useMemo(() => {
    if (!project || features.length === 0) return null
    // Splat-bearing dots last, so they land on top where features overlap.
    return features
      .map((feature) => ({ ...feature, ...project(feature.lat, feature.lon) }))
      .sort((a, b) => Number(Boolean(a.modelPath)) - Number(Boolean(b.modelPath)))
  }, [features, project])

  const openSplat = (feature) => {
    if (!feature.modelPath) return
    // Same shape Home.jsx uses, so the viewer's existing effect picks it up.
    navigate('/viewer', { state: { modelPath: feature.modelPath, name: feature.name } })
  }

  const error = fetchError || parseError
  const status = loading
    ? 'Loading buildings…'
    : buildings
      ? `${buildings.returned.toLocaleString()} of ${buildings.total.toLocaleString()} buildings`
      : 'No buildings'

  const mapView = useMemo(() => {
    if (!mapData || !project) {
      return null
    }

    const renderedWays = []
    const renderedAreas = []

    for (const way of mapData.ways) {
      const points = way.refs
        .map((ref) => mapData.nodes.get(ref))
        .filter(Boolean)
        .map((node) => ({
          ...node,
          ...project(node.lat, node.lon),
        }))

      if (points.length < 2) {
        continue
      }

      const closed = way.refs[0] === way.refs[way.refs.length - 1] && points.length > 2
      const style = getWayStyle(way.tags)
      const isArea = Boolean(way.tags.building || way.tags.landuse || way.tags.leisure || way.tags.natural === 'water')
      const isBuilding = Boolean(way.tags.building)
      const pointsAttribute = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')

      if (closed && isArea) {
        renderedAreas.push({ id: way.id, pointsAttribute, style, isBuilding })
      } else {
        renderedWays.push({ id: way.id, pointsAttribute, style })
      }
    }

    const nodeMarkers = Array.from(mapData.nodes.values())
      .filter((node) => getNodeLabel(node.tags) || interestingNodeTags.some((tag) => node.tags[tag]))
      .sort((left, right) => nodePriority(right.tags) - nodePriority(left.tags))
      .slice(0, 24)
      .map((node) => ({
        ...node,
        label: getNodeLabel(node.tags),
        ...project(node.lat, node.lon),
      }))

    return {
      renderedAreas,
      renderedWays,
      nodeMarkers,
    }
  }, [mapData, project])

  // Features come from context and need no fetch, so they can carry the map on
  // their own: only wait on the buildings request when there is nothing to draw.
  if (loading && !featureView) {
    return <div className={className} aria-label="Map preview"><div className="map-loading">Loading map…</div></div>
  }

  if (error && !buildingView && !featureView) {
    return <div className={className} aria-label="Map preview"><div className="map-loading">{error}</div></div>
  }

  if (!buildingView && !mapView && !featureView) {
    return (
      <div className={className} aria-label="Map preview">
        <div className="map-loading">Nothing on the map yet — add a node or a region first.</div>
      </div>
    )
  }

  return (

      <div className={className} aria-label="Map preview">
        {buildingView || mapView || featureView ? (
          <svg
            className="map-svg"
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            role="img"
            aria-label={
              buildingView
                ? `Miniature map of ${buildingView.shapes.length} building footprints, shaded by volume`
                : 'Miniature map'
            }
          >
            <defs>
              <linearGradient id="mapBackground" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f3e8d3" />
                <stop offset="100%" stopColor="#dcc9ac" />
              </linearGradient>
              <radialGradient id="glow" cx="50%" cy="38%" r="60%">
                <stop offset="0%" stopColor="#fff8e3" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#fff8e3" stopOpacity="0" />
              </radialGradient>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="10" stdDeviation="16" floodColor="#1f2430" floodOpacity="0.28" />
              </filter>
              {/* Texture, not colour, marks "not measured" — it survives
                  greyscale, colourblindness and print, where a grey fill would
                  just read as another class. */}
              <pattern id="noLidar" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="8" height="8" fill={NO_DATA_FILL.roof} />
                <line x1="0" y1="0" x2="0" y2="8" stroke={NO_DATA_FILL.wall} strokeWidth="3" />
              </pattern>
            </defs>

            <rect x="0" y="0" width={svgSize} height={svgSize} fill="url(#mapBackground)" />
            <rect x="0" y="0" width={svgSize} height={svgSize} fill="url(#glow)" opacity="0.48" />

            {Array.from({ length: 7 }, (_, index) => {
              const position = svgPadding + ((svgSize - svgPadding * 2) / 6) * index

              return (
                <g key={`grid-${index}`} opacity="0.18">
                  <line x1={position} y1={svgPadding * 0.5} x2={position} y2={svgSize - svgPadding * 0.5} stroke="#7d8aa0" strokeDasharray="10 12" strokeWidth="1.4" />
                  <line x1={svgPadding * 0.5} y1={position} x2={svgSize - svgPadding * 0.5} y2={position} stroke="#7d8aa0" strokeDasharray="10 12" strokeWidth="1.4" />
                </g>
              )
            })}

            {/* Road / water / landuse context, only when a map.osm was passed in. */}
            {mapView ? (
              <>
                {mapView.renderedAreas.map((area) => (
                  <polygon
                    key={area.id}
                    points={area.pointsAttribute}
                    fill={area.style.fill ?? 'rgba(136, 111, 0, 0.2)'}
                    stroke={area.style.stroke}
                    strokeWidth={area.style.strokeWidth}
                    strokeLinejoin="round"
                  />
                ))}
                {mapView.renderedWays.map((way) => (
                  <polyline
                    key={way.id}
                    points={way.pointsAttribute}
                    fill="none"
                    stroke={way.style.stroke}
                    strokeWidth={way.style.strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={way.style.dashArray}
                    opacity="0.95"
                  />
                ))}
              </>
            ) : null}

            {/* Buildings, far to near so the extrusions overlap correctly. */}
            {buildingView
              ? buildingView.shapes.map((shape) => {
                  const active = hovered?.key === shape.key
                  return (
                    <g
                      key={shape.key}
                      onMouseEnter={() => setHovered(shape)}
                      onMouseLeave={() => setHovered((current) => (current?.key === shape.key ? null : current))}
                      style={{ cursor: 'pointer' }}
                    >
                      {shape.walls.map((wall, index) => (
                        <polygon key={index} points={wall} fill={shape.palette.wall} />
                      ))}
                      <polygon
                        points={shape.roofPath}
                        fill={shape.measured ? shape.palette.roof : 'url(#noLidar)'}
                        stroke={active ? '#0b0b0b' : shape.palette.wall}
                        strokeWidth={active ? 3 : 1}
                        strokeLinejoin="round"
                      />
                    </g>
                  )
                })
              : null}

            {mapView
              ? mapView.nodeMarkers.map((node) => (
                  <g key={node.id} filter="url(#softShadow)">
                    <circle cx={node.x} cy={node.y} r="11" fill="#1b2432" opacity="0.9" />
                    <circle cx={node.x} cy={node.y} r="5.5" fill={node.label ? '#ff9b5e' : '#8ad9ff'} />
                    {node.label ? (
                      <>
                        <text x={node.x + 18} y={node.y - 12} fill="#1f2836" fontSize="22" fontWeight="700" paintOrder="stroke" stroke="#f6ecd7" strokeWidth="6" strokeLinejoin="round">
                          {node.label}
                        </text>
                        <text x={node.x + 18} y={node.y - 12} fill="#2d3848" fontSize="22" fontWeight="700">
                          {node.label}
                        </text>
                      </>
                    ) : null}
                  </g>
                ))
              : null}

            {/* Nodes and regions as points. Orange means a splat exists and the
                dot opens it; neutral means nothing has been generated there. */}
            {featureView
              ? featureView.map((feature) => {
                  const openable = Boolean(feature.modelPath)
                  const active = hoveredFeature?.key === feature.key
                  return (
                    <g
                      key={feature.key}
                      role={openable ? 'button' : undefined}
                      tabIndex={openable ? 0 : undefined}
                      aria-label={openable ? `Open ${feature.name} in the viewer` : feature.name}
                      style={{ cursor: openable ? 'pointer' : 'default', outline: 'none' }}
                      onMouseEnter={() => setHoveredFeature(feature)}
                      onMouseLeave={() => setHoveredFeature((current) => (current?.key === feature.key ? null : current))}
                      onFocus={() => setHoveredFeature(feature)}
                      onBlur={() => setHoveredFeature((current) => (current?.key === feature.key ? null : current))}
                      onClick={() => openSplat(feature)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          openSplat(feature)
                        }
                      }}
                    >
                      {/* Invisible, larger hit area: a 9px dot is a hard target. */}
                      <circle cx={feature.x} cy={feature.y} r="22" fill="transparent" />
                      {active ? (
                        <circle cx={feature.x} cy={feature.y} r="17" fill="none" stroke={POINT_RING} strokeWidth="2.5" opacity="0.65" />
                      ) : null}
                      <circle
                        cx={feature.x}
                        cy={feature.y}
                        r={openable ? 11 : 8}
                        fill={openable ? SPLAT_POINT : EMPTY_POINT}
                        stroke={POINT_RING}
                        strokeWidth="2.5"
                      />
                      {/* A dot inside marks "openable" without relying on hue. */}
                      {openable ? <circle cx={feature.x} cy={feature.y} r="3.5" fill="#fdf6e8" /> : null}
                    </g>
                  )
                })
              : null}

            <rect x={svgPadding - 16} y={svgPadding - 16} width={svgSize - (svgPadding - 16) * 2} height={svgSize - (svgPadding - 16) * 2} fill="none" stroke="#5e6d82" strokeOpacity="0.5" strokeWidth="2" />

            {/* Legend. Identity never rests on colour alone: every class is
                labelled with the volume range it stands for. */}
            {buildingView?.breaks ? (
              <g transform={`translate(${svgPadding}, ${svgPadding})`}>
                <rect x="-14" y="-24" width="330" height="176" rx="8" fill="#fdf6e8" fillOpacity="0.9" stroke="#c3b79c" />
                <text x="0" y="-2" fill="#243041" fontSize="19" fontWeight="700">Building volume</text>
                {VOLUME_RAMP.map((entry, index) => {
                  const [low, mid, high] = buildingView.breaks
                  const label = [
                    `up to ${formatVolume(low)}`,
                    `${formatVolume(low)} – ${formatVolume(mid)}`,
                    `${formatVolume(mid)} – ${formatVolume(high)}`,
                    `over ${formatVolume(high)}`,
                  ][index]
                  return (
                    <g key={entry.roof} transform={`translate(0, ${12 + index * 26})`}>
                      <rect width="22" height="14" rx="3" fill={entry.roof} />
                      <text x="32" y="12" fill="#3a4655" fontSize="16">{label}</text>
                    </g>
                  )
                })}
                <g transform="translate(0, 116)">
                  <rect width="22" height="14" rx="3" fill="url(#noLidar)" stroke="#8b877d" />
                  <text x="32" y="12" fill="#3a4655" fontSize="16">no LiDAR cover</text>
                </g>
                <text x="0" y="150" fill="#6c6559" fontSize="14">
                  {Math.abs(buildingView.liftScale - 1) < 0.05
                    ? 'heights and footprints to scale'
                    : `heights ×${buildingView.liftScale.toFixed(1)} · footprints to scale`}
                </text>
              </g>
            ) : null}

            {/* Metric scale bar — the point of fixing the projection. */}
            {buildingView ? (
              <g transform={`translate(${svgPadding}, ${svgSize - svgPadding - 6})`}>
                <line x1="0" y1="0" x2={buildingView.scaleBar.width} y2="0" stroke="#243041" strokeWidth="3" />
                <line x1="0" y1="-6" x2="0" y2="6" stroke="#243041" strokeWidth="3" />
                <line x1={buildingView.scaleBar.width} y1="-6" x2={buildingView.scaleBar.width} y2="6" stroke="#243041" strokeWidth="3" />
                <text x={buildingView.scaleBar.width / 2} y="-12" fill="#243041" fontSize="17" fontWeight="600" textAnchor="middle">
                  {buildingView.scaleBar.metres >= 1000
                    ? `${buildingView.scaleBar.metres / 1000} km`
                    : `${buildingView.scaleBar.metres} m`}
                </text>
              </g>
            ) : null}

            {/* Hover readout. Exact numbers live here, so colour is never the
                only way to get a value out of the map. */}
            {hovered && !hoveredFeature ? (
              <g transform={`translate(${svgSize - svgPadding - 300}, ${svgPadding})`}>
                <rect x="-14" y="-24" width="314" height={hovered.measured ? 132 : 84} rx="8" fill="#fdf6e8" fillOpacity="0.95" stroke="#c3b79c" />
                <text x="0" y="-2" fill="#243041" fontSize="19" fontWeight="700">
                  {hovered.properties.name || `Building ${hovered.properties.osm_id ?? ''}`.trim()}
                </text>
                {hovered.measured ? (
                  <>
                    <text x="0" y="26" fill="#3a4655" fontSize="16">height {formatMetres(hovered.properties.height_m)}</text>
                    <text x="0" y="50" fill="#3a4655" fontSize="16">
                      footprint {Math.round(hovered.properties.footprint_area_m2 ?? 0).toLocaleString()} m²
                    </text>
                    <text x="0" y="74" fill="#3a4655" fontSize="16">volume {formatVolume(volumeOf(hovered.properties))}</text>
                    <text x="0" y="98" fill="#6c6559" fontSize="14">
                      LiDAR cover {Math.round((hovered.properties.coverage ?? 0) * 100)}%
                    </text>
                  </>
                ) : (
                  <text x="0" y="30" fill="#6c6559" fontSize="16">not covered by LiDAR — height unknown</text>
                )}
              </g>
            ) : null}
          </svg>
        ) : (
          <div className="map-loading">Building the map square...</div>
        )}

        {/* Legend and readout live in HTML, not in the SVG: the panel is 320px
            wide, so text sized inside a 1000-unit viewBox renders around 4px. */}
        {featureView ? (
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
        ) : null}

        {featureView || buildingView ? (
          <p className="map-caption">
            {hoveredFeature ? (
              <>
                <strong>{hoveredFeature.name}</strong>
                {` · ${hoveredFeature.lat.toFixed(5)}, ${hoveredFeature.lon.toFixed(5)} · `}
                {hoveredFeature.modelPath ? 'click to open' : 'no splat yet'}
              </>
            ) : (
              <>
                {featureView
                  ? `${featureView.filter((f) => f.modelPath).length} of ${featureView.length} with a splat`
                  : status}
                {buildingView ? ` · ${status}` : ''}
                {buildingView && buildingView.measuredCount < buildingView.shapes.length
                  ? ` · ${buildingView.shapes.length - buildingView.measuredCount} without LiDAR cover`
                  : ''}
              </>
            )}
          </p>
        ) : null}
      </div>
  )
}

export default OSMViewer