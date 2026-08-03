import { useMemo } from 'react'

const svgSize = 1000
const svgPadding = 74

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

const makeProjector = (bounds) => {
  const latSpan = Math.max(bounds.maxLat - bounds.minLat, 0.000001)
  const lonSpan = Math.max(bounds.maxLon - bounds.minLon, 0.000001)
  const innerSize = svgSize - svgPadding * 2

  return (lat, lon) => ({
    x: svgPadding + ((lon - bounds.minLon) / lonSpan) * innerSize,
    y: svgSize - svgPadding - ((lat - bounds.minLat) / latSpan) * innerSize,
  })
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

const mapParseResult = (() => {
  if (typeof DOMParser === 'undefined') {
    return {
      data: null,
      error: 'Unable to parse map.osm outside the browser',
      status: 'Map unavailable',
    }
  }

  try {
    const data = parseOsm("")

    return {
      data,
      error: '',
      status: `Loaded ${data.nodes.size.toLocaleString()} nodes and ${data.ways.length.toLocaleString()} ways`,
    }
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : 'Unable to read map.osm'

    return {
      data: null,
      error: message,
      status: 'Map unavailable',
    }
  }
})()

function OSMViewer({ className = 'map-card' } = {}) {
  const mapData = mapParseResult.data
  const status = mapParseResult.status
  const error = mapParseResult.error

  const mapView = useMemo(() => {
    if (!mapData) {
      return null
    }

    const project = makeProjector(mapData.bounds)
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
  }, [mapData])

  const boundsLabel = mapData
    ? `${mapData.bounds.minLat.toFixed(3)}, ${mapData.bounds.minLon.toFixed(3)} → ${mapData.bounds.maxLat.toFixed(3)}, ${mapData.bounds.maxLon.toFixed(3)}`
    : ''

  const nodeCount = mapData?.nodes.size ?? 0
  const wayCount = mapData?.ways.length ?? 0

  return (

      <div className={className} aria-label="Map preview">
        {mapData && mapView ? (
          <svg className="map-svg" viewBox={`0 0 ${svgSize} ${svgSize}`} role="img" aria-label="Miniature map based on map.osm">
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

            {mapView.renderedAreas.filter((area) => area.isBuilding).map((area) => (
              <polygon
                key={`${area.id}-outline`}
                points={area.pointsAttribute}
                fill="none"
                stroke="#cc0a0a"
                strokeWidth={area.style.strokeWidth + 5}
                strokeLinejoin="round"
                opacity="0.45"
              />
            ))}

            {mapView.renderedAreas.map((area) => (
              <polygon
                key={area.id}
                points={area.pointsAttribute}
                fill={area.style.fill ?? 'rgba(136, 111, 0, 0.2)'}
                stroke={area.style.stroke}
                strokeWidth={area.style.strokeWidth}
                strokeLinejoin="round"
                opacity="1"
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

            {mapView.nodeMarkers.map((node) => (
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
            ))}

            <rect x={svgPadding - 16} y={svgPadding - 16} width={svgSize - (svgPadding - 16) * 2} height={svgSize - (svgPadding - 16) * 2} fill="none" stroke="#5e6d82" strokeOpacity="0.5" strokeWidth="2" />
            <text x={svgPadding} y={svgSize - 34} fill="#243041" fontSize="24" fontWeight="700">
              map.osm
            </text>
          </svg>
        ) : (
          <div className="map-loading">Building the map square...</div>
        )}
      </div>
  )
}

export default OSMViewer