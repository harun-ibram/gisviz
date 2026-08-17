import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Polygon, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import {
  formatMetres,
  formatVolume,
  heightSourceOf,
  outerRings,
  ringContains,
  volumeBreaks,
  volumeClass,
  volumeOf,
} from '../gis/buildings.js'
import { fillHeightsFromGeotiff } from '../gis/geotiffHeights.js'
import {
  EMPTY_POINT,
  EMPTY_POINT_WALL,
  mapBoundsToApiBbox,
  NO_DATA_COLOUR,
  NO_DATA_WALL,
  SPLAT_POINT,
  SPLAT_POINT_WALL,
  VOLUME_RAMP_DARK_BG,
  VOLUME_RAMP_DARK_BG_WALL,
} from '../gis/gisGeo.js'

/**
 * Measured buildings on the location map, faked into 2.5D.
 *
 * "Measured" is two sources, not one. `/gis/buildings` returns heights the
 * backend derived from LiDAR; everything it left null goes through
 * gis/geotiffHeights.js, which samples an uploaded GeoTIFF surface in the
 * browser for the same measurement. A footprint is drawn flat only when
 * neither covered it.
 *
 * Leaflet is flat, so height is drawn the way a cabinet projection draws it:
 * the roof is the footprint translated straight up the screen by exactly the
 * pixels its height occupies on the ground, and the walls are the quads that
 * connect the two. Colour still encodes volume, identically to the 3D viewer —
 * the offset says how tall, the hue says how big.
 *
 * "Exactly the pixels" is the load-bearing part. An earlier minimap multiplied
 * height by a constant 4 and became a bar chart: every building the same
 * cartoon tower, unrelated to zoom. True scale means the effect fades as you
 * zoom out, which is correct — at zoom 13 a 20 m building really is one pixel
 * tall — and MIN_ZOOM below turns the layer off before it gets there.
 */

// Under this, a real building's offset is sub-pixel and the bbox would be
// county-sized. Not worth a request; the caption says to zoom in instead.
const MIN_ZOOM = 14

// Two SVG paths per building, on a map that is a sidebar panel.
const MAX_BUILDINGS = 500

// A 200 m tower at zoom 19 offsets ~330px and throws its roof clean off a
// 220px map, leaving walls with no visible top. Clamping distorts the tallest
// few; letting them escape the viewport loses them entirely.
const MAX_OFFSET_PX = 90

// A drag fires moveend once, but a wheel zoom fires a burst of them.
const DEBOUNCE_MS = 300

/** Screen pixels for `metres` of altitude at this zoom and latitude. */
const metresToPixels = (metres, lat, zoom) => {
  const metresPerPixel = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8)
  return metres / metresPerPixel
}

/**
 * Signed area in screen space, where y grows downward.
 *
 * Positive means the ring is clockwise *on screen* — the y flip inverts the
 * usual convention, so this cannot be borrowed from a maths reference without
 * checking. It decides which way "outward" points, one line below.
 */
const signedArea = (points) => {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/**
 * Does this edge face the viewer?
 *
 * The roof is offset straight up, so the viewer sits below the map and an edge
 * is visible when its outward normal has a positive y. For a clockwise-on-screen
 * ring the outward normal of edge e is (e.y, -e.x), so that reduces to e.x < 0;
 * counter-clockwise flips it. Drawing only these halves the path count and,
 * more importantly, stops back walls from poking out above their own roof.
 */
const facesViewer = (from, to, clockwise) => (clockwise ? to.x < from.x : to.x > from.x)

/**
 * One building as the paths that draw it.
 *
 * Returns null for anything with no usable ring. `walls` is empty when the
 * height is unknown, and the caller draws a flat footprint instead — a
 * zero-height extrusion would say "this building is 0 m tall", which is a
 * different claim from "we did not measure it".
 */
function toBody(feature, ring, key, map, zoom, breaks, targets) {
  if (!Array.isArray(ring) || ring.length < 3) return null

  const base = ring.map(([lon, lat]) => map.project([lat, lon], zoom))
  const area = signedArea(base)
  if (area === 0) return null

  const properties = feature.properties ?? {}
  const height = properties.height_m
  const source = heightSourceOf(properties)
  const cls = volumeClass(volumeOf(properties), breaks)

  const north = Math.max(...ring.map(([, lat]) => lat))
  const centreLon = ring.reduce((total, [lon]) => total + lon, 0) / ring.length
  const centreLat = ring.reduce((total, [, lat]) => total + lat, 0) / ring.length

  // Whose splat is this building the subject of, if any?
  //
  // The vertex mean, not a true centroid: on an L-shaped footprint the mean can
  // fall outside the building itself, but a user's drawn outline is always the
  // larger shape, so it still lands inside the thing we are testing against.
  const target = targets.find((entry) =>
    entry.rings.some((outline) => ringContains(outline, centreLon, centreLat)))

  const unproject = (points) => points.map((point) => map.unproject(point, zoom))
  const basePositions = unproject(base)

  let roofColour = cls === null ? NO_DATA_COLOUR : VOLUME_RAMP_DARK_BG[cls]
  let wallColour = cls === null ? NO_DATA_WALL : VOLUME_RAMP_DARK_BG_WALL[cls]
  if (target) {
    roofColour = target.openable ? SPLAT_POINT : EMPTY_POINT
    wallColour = target.openable ? SPLAT_POINT_WALL : EMPTY_POINT_WALL
  }

  const body = {
    key,
    north,
    name: properties.name ?? null,
    height,
    source,
    volume: volumeOf(properties),
    coverage: properties.coverage ?? null,
    target: target ?? null,
    roofColour,
    wallColour,
    measured: typeof height === 'number' && height > 0,
    roof: basePositions,
    walls: [],
  }

  if (!body.measured) return body

  const offset = Math.min(metresToPixels(height, centreLat, zoom), MAX_OFFSET_PX)
  // Under a pixel of lift is not a building you can see the height of, and the
  // walls would be a hairline of the wrong colour along every edge.
  if (offset < 1) return body

  const roof = base.map((point) => ({ x: point.x, y: point.y - offset }))
  body.roof = unproject(roof)

  const clockwise = area > 0
  for (let i = 0; i < base.length; i += 1) {
    const next = (i + 1) % base.length
    if (!facesViewer(base[i], base[next], clockwise)) continue
    body.walls.push(unproject([base[i], base[next], roof[next], roof[i]]))
  }

  return body
}

function MapBuildings({ apiBaseUrl, onStatus, targets = [], onOpen }) {
  const map = useMap()
  const [zoom, setZoom] = useState(() => map.getZoom())
  const [bbox, setBbox] = useState(() => mapBoundsToApiBbox(map.getBounds()))
  // Kept together with the bbox they were fetched for, so a pan can keep
  // drawing the old buildings while the new ones are in flight without also
  // reporting their stale count in the caption. `geotiff` is what the
  // browser-side pass added on top, or null when it had nothing to add.
  const [loaded, setLoaded] = useState({ key: null, features: [], total: 0, geotiff: null })
  const timerRef = useRef(null)

  // Zoom is taken immediately but the bbox is debounced: geometry is projected
  // at `zoom`, so letting that lag behind the map would slide every building
  // sideways for the length of the debounce.
  const scheduleBbox = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setBbox(mapBoundsToApiBbox(map.getBounds())), DEBOUNCE_MS)
  }, [map])

  useMapEvents({
    moveend: scheduleBbox,
    zoomend: () => {
      setZoom(map.getZoom())
      scheduleBbox()
    },
  })

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  // Rounded so a sub-metre pan does not re-fetch identical data.
  const bboxKey = bbox ? bbox.map((value) => value.toFixed(5)).join(',') : null

  // Zoomed out too far, the last fetch's features are kept in state but not
  // drawn. Clearing them here instead would be a synchronous setState in an
  // effect — a cascading render — and would also mean a re-fetch every time you
  // dip below the threshold and come back.
  const active = Boolean(bboxKey) && zoom >= MIN_ZOOM

  useEffect(() => {
    if (!active) {
      onStatus(zoom < MIN_ZOOM ? { kind: 'zoom' } : null)
      return undefined
    }

    const controller = new AbortController()
    const url = `${apiBaseUrl}/gis/buildings?bbox=${bboxKey}&limit=${MAX_BUILDINGS}`
    let live = true

    const load = async () => {
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const data = await response.json()
        if (!live) return

        const found = data.features ?? []
        const total = data.total ?? found.length

        // Drawn before the GeoTIFF pass, not after it: the LiDAR heights are
        // already in hand, and holding the whole layer back for a raster read
        // would make every pan feel like the map had stalled.
        setLoaded({ key: bboxKey, features: found, total, geotiff: null })

        // Parsed back out of the key rather than closed over `bbox`: setBbox
        // hands out a fresh array on every moveend, so depending on it would
        // re-fetch after a pan too small to change the rounded key.
        const bounds = bboxKey.split(',').map(Number)
        const filled = await fillHeightsFromGeotiff(found, {
          apiBaseUrl,
          bbox: bounds,
          signal: controller.signal,
        })

        if (!live || (filled.filled === 0 && !filled.note)) return
        setLoaded({ key: bboxKey, features: filled.features, total, geotiff: filled })
      } catch (cause) {
        if (cause.name === 'AbortError' || !live) return
        setLoaded({ key: bboxKey, features: [], total: 0, geotiff: null })
        onStatus({ kind: 'error', message: cause.message })
      }
    }

    load()

    return () => {
      live = false
      controller.abort()
    }
  }, [active, apiBaseUrl, bboxKey, zoom, onStatus])

  const features = loaded.features

  const bodies = useMemo(() => {
    if (!active || features.length === 0) return []

    // Breaks over this viewport, matching the viewer's own quartiles over its
    // own set. Both are data-driven, so the same building can change class as
    // you pan — the alternative, fixed thresholds, collapses a village and a
    // city centre into one colour.
    const breaks = volumeBreaks(features.map((feature) => volumeOf(feature.properties)))

    const built = []
    for (const feature of features) {
      outerRings(feature.geometry).forEach((ring, index) => {
        const body = toBody(feature, ring, `${feature.id}-${index}`, map, zoom, breaks, targets)
        if (body) built.push(body)
      })
    }

    // Painter's algorithm: northernmost is farthest from a viewer below the
    // map, so it is drawn first and the ones in front overlap it. Without this
    // a near building's roof ends up under a far building's walls.
    built.sort((a, b) => b.north - a.north)
    return built
  }, [active, features, map, targets, zoom])

  // Reported from `bodies`, not from the fetch, because the splat match only
  // exists once the geometry has been built. Gated on the loaded bbox matching
  // the current one, or a pan would flash "no buildings measured here" between
  // firing the request and getting it back.
  const fresh = active && loaded.key === bboxKey
  useEffect(() => {
    if (!fresh) return
    onStatus({
      kind: 'ok',
      shown: bodies.length,
      total: loaded.total,
      measured: bodies.filter((body) => body.measured).length,
      // Counted off the drawn bodies rather than taken from the pass's own
      // tally: the pass measures every footprint it was handed, while these are
      // the ones that survived into geometry.
      geotiff: bodies.filter((body) => body.source === 'geotiff').length,
      groundFromSurface: loaded.geotiff?.groundFromSurface ?? false,
      geotiffNote: loaded.geotiff?.note ?? null,
      splats: bodies.filter((body) => body.target).length,
    })
  }, [bodies, fresh, loaded.total, loaded.geotiff, onStatus])

  return bodies.map((body) => (
    <Fragment key={body.key}>
      {body.walls.length > 0 ? (
        <Polygon
          // Every wall of one building is one path: an array of rings would be
          // read as holes, so each quad is wrapped to make it a multi-polygon.
          positions={body.walls.map((quad) => [quad])}
          interactive={false}
          pathOptions={{
            // nonzero, not Leaflet's default evenodd: on a concave footprint
            // two front walls can overlap, and evenodd punches that hole out.
            fillRule: 'nonzero',
            fillColor: body.wallColour,
            fillOpacity: 1,
            color: body.roofColour,
            weight: 1,
            opacity: 0.7,
          }}
        />
      ) : null}

      <Polygon
        positions={body.roof}
        className={body.target?.openable ? 'gv-splat-point--open' : undefined}
        pathOptions={{
          fillColor: body.roofColour,
          // Opaque where measured, so it covers the back walls beneath it.
          fillOpacity: body.measured ? 1 : 0.4,
          // A splat's building takes a light rim: it is the one thing on this
          // map you can act on, and orange-on-blue alone does not survive a
          // dense block where the neighbours are already saturated.
          color: body.target ? '#ffffff' : body.roofColour,
          weight: body.target ? 1.5 : 1,
        }}
        eventHandlers={body.target?.openable ? { click: () => onOpen?.(body.target) } : undefined}
      >
        <Tooltip direction="top" sticky>
          <strong>{body.target?.name ?? body.name ?? 'Building'}</strong>
          <br />
          {body.height === null || body.height === undefined
            ? 'No elevation cover — height unknown'
            : `${formatMetres(body.height)} · ${formatVolume(body.volume)}`}
          {/* Which surface produced the number, on its own line: a GeoTIFF
              height is measured the same way but off a coarser and usually
              older grid, so it is worth knowing before quoting it. */}
          {body.source ? (
            <>
              <br />
              <span className="text-muted">
                {body.source === 'geotiff' ? 'from GeoTIFF surface' : 'from LiDAR'}
              </span>
            </>
          ) : null}
          {body.target ? (
            <>
              <br />
              {body.target.openable ? 'Click to open this splat' : 'Marked, no splat generated yet'}
            </>
          ) : null}
        </Tooltip>
      </Polygon>
    </Fragment>
  ))
}

export default MapBuildings
