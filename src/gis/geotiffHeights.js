/**
 * Building heights measured in the browser, against an uploaded GeoTIFF.
 *
 * The LiDAR path measures heights server-side: `building_heights.py` grids a
 * point cloud into a DSM/DEM pair and writes `height_m` onto every footprint,
 * which `/gis/buildings` then hands to the map and the 3D viewer. A GeoTIFF
 * surface uploaded through `/gis` never enters that pipeline — the buildings
 * table keys its measurement to a `lidar_layer_id` — so a user with a DSM
 * GeoTIFF and OSM footprints sees flat boxes and "height unknown".
 *
 * This module closes that gap from the client. It is the same measurement,
 * with the same constants and the same percentiles as building_heights.py,
 * done over a windowed read of the layer's WGS84 GeoTIFF:
 *
 *     roof   = P75 of the DSM cells under the footprint
 *     ground = P10 of the DEM cells in a 2 m ring outside it
 *     height = max(roof - ground, 0)
 *
 * Percentiles rather than max/min because chimneys, antennas and parapets
 * wreck a MAX and one stray low return wrecks a MIN.
 *
 * Only footprints that came back with a null `height_m` are measured. LiDAR
 * wins wherever it exists: it is the denser and better-classified surface, and
 * silently replacing it would make the two views disagree with the database.
 *
 * ## Two deliberate divergences from the Python
 *
 * 1. **The raster is geographic.** `building_heights.py` rejects a WGS84 grid
 *    outright, because it derives areas from cell counts and cell counts in
 *    degrees are meaningless. The only artifact the backend publishes is the
 *    reprojected `*_4326.tif`, so that rejection is not available here. A
 *    height is a difference of two elevations and survives the reprojection
 *    untouched; the *areas* are the part that needs care, so every area and
 *    volume below is computed in metres through a local equirectangular scale
 *    rather than from a degree-sized cell.
 *
 * 2. **The DSM and DEM need not be the same grid.** The Python asserts the two
 *    rasters are cell-for-cell identical, which holds when one tile produced
 *    both. Here they are two independent uploads at possibly different
 *    resolutions, so ground is sampled by geographic lookup rather than by
 *    shared pixel index.
 *
 * With no DEM uploaded at all, ground falls back to the ring of the DSM
 * itself — the standard nDSM-from-a-surface-alone trick. It is honest on open
 * ground and optimistic inside a dense terrace, where the ring lands on the
 * neighbours' roofs; callers surface that in the caption rather than hiding it.
 */

import { outerRings, ringContains } from './buildings.js'

// Mirrors building_heights.py's defaults exactly. Changing one of these without
// changing it there means the same building measures differently depending on
// which surface happened to cover it, which is worse than either number alone.
const RING_M = 2.0
const GROUND_PERCENTILE = 10
const ROOF_PERCENTILE = 75
const MIN_COVERAGE = 0.30

const METRES_PER_DEGREE_LAT = 111320

// One windowed read, not one per building: 500 footprints would otherwise be
// 500 range requests. The budget is what that single read is allowed to cost —
// a 0.1 m raster over a zoom-14 viewport is ~290M cells, so this is reached in
// practice and the overview ladder below is the answer, not an optimisation.
const MAX_WINDOW_CELLS = 6_000_000

// The rasterisation below is synchronous on the main thread. At ~2000
// footprints of a few hundred cells each it stays under a frame or two; well
// past that it would be a visible stall and belongs in a worker.
const MAX_FEATURES = 2000

// A single footprint bigger than this is a digitising error (a whole district
// tagged as one building), and rasterising it would freeze the tab.
const MAX_FOOTPRINT_CELLS = 250_000

// Signed R2 URLs last an hour; re-opening well before that keeps a long
// session from hitting a 403 mid-pan.
const GRID_CACHE_TTL_MS = 25 * 60 * 1000

/** geotiff_key -> { promise, openedAt }. Module scope so a pan reuses the open file. */
const gridCache = new Map()

const metresPerDegreeLon = (lat) => METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180)

const round = (value, places) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * Linear-interpolated percentile over an already-sorted ascending array.
 *
 * Matches numpy's default so a building measured here and the same building
 * measured by building_heights.py agree to the rounding.
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]

  const rank = (fraction / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)

  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

/**
 * The newest usable DSM and DEM among GeoTIFF raster layers.
 *
 * `kind: 'raster'` is excluded on purpose: that option means "generic values",
 * so the numbers in it are explicitly not elevations and extruding a building
 * by one would invent a measurement.
 */
export function pickElevationLayers(layers) {
  const usable = (layers ?? []).filter((layer) => layer?.geometry_class === 'raster'
    && layer.layer_type === 'tiff'
    && layer.geotiff_url
    && Array.isArray(layer.bounds)
    && layer.bounds.length === 4)

  const newest = (kind) => usable
    .filter((layer) => layer.kind === kind)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null

  return { dsm: newest('dsm'), dem: newest('dem') }
}

/**
 * Open a layer's GeoTIFF and describe every resolution level in it.
 *
 * `fromUrl` reads over HTTP range requests, so this costs a couple of KB of
 * header rather than the whole file — the point of pointing it at the raw
 * GeoTIFF instead of the overlay PNG the map already draws.
 */
async function openGrid(layer) {
  const cached = gridCache.get(layer.geotiff_key)
  if (cached && Date.now() - cached.openedAt < GRID_CACHE_TTL_MS) return cached.promise

  const promise = (async () => {
    // Imported here rather than at module scope so the TIFF reader and its
    // codecs stay out of the viewer's bundle for everyone who has no elevation
    // layer to sample — which is the state the map starts in.
    const { fromUrl } = await import('geotiff')
    return describeGrid(await fromUrl(layer.geotiff_url), layer)
  })()

  // A failed open must not be cached, or one expired URL poisons the session.
  promise.catch(() => gridCache.delete(layer.geotiff_key))
  gridCache.set(layer.geotiff_key, { promise, openedAt: Date.now() })
  return promise
}

/**
 * Every resolution level in an open TIFF, finest first.
 *
 * Split out of openGrid so it takes a parsed TIFF rather than a URL: this is
 * the half with the georeferencing assumptions in it, and it can be exercised
 * against a file in memory.
 */
export async function describeGrid(tiff, layer) {
  const count = await tiff.getImageCount()
  const levels = []

  for (let index = 0; index < count; index += 1) {
    // Sequential on purpose: each getImage parses an IFD that the previous one
    // points at, so there is nothing to parallelise.
    const image = await tiff.getImage(index)
    const [west, south, east, north] = image.getBoundingBox()
    const width = image.getWidth()
    const height = image.getHeight()

    if (!(width > 0 && height > 0) || !(east > west) || !(north > south)) continue

    // A rotated or sheared grid would need a full affine inverse for every
    // lookup below, which assumes north-up. gdalwarp does not produce one for
    // the 4326 output, so this is a guard rather than a case to handle — and it
    // has to be a real one, because getBoundingBox() happily projects the four
    // corners of a rotated grid and hands back a plausible north-up box.
    //
    // The directory is an ImageFileDirectory with getValue() in geotiff 3, and
    // was a plain tag object before that.
    const directory = image.getFileDirectory?.()
    const transform = typeof directory?.getValue === 'function'
      ? directory.getValue('ModelTransformation')
      : directory?.ModelTransformation

    if (transform && (Math.abs(transform[1]) > 1e-12 || Math.abs(transform[4]) > 1e-12)) {
      throw new Error('This GeoTIFF is rotated; heights need a north-up grid.')
    }

    levels.push({
      image,
      width,
      height,
      west,
      north,
      pxLon: (east - west) / width,
      pxLat: (north - south) / height,
      nodata: image.getGDALNoData(),
    })
  }

  if (levels.length === 0) throw new Error('This GeoTIFF has no readable image.')

  // Full resolution first; readTile walks down the ladder from there.
  levels.sort((a, b) => b.width - a.width)

  // `layer.bounds` is what the API published for this raster and what every
  // other part of the page clips against; the image's own box is only used for
  // the pixel maths, per level.
  return { layer, levels, bounds: layer.bounds }
}

/** Pixel window `[x0, y0, x1, y1]` covering a WGS84 bbox, clamped to the level. */
function windowFor(level, [west, south, east, north]) {
  const x0 = Math.max(0, Math.floor((west - level.west) / level.pxLon))
  const x1 = Math.min(level.width, Math.ceil((east - level.west) / level.pxLon))
  const y0 = Math.max(0, Math.floor((level.north - north) / level.pxLat))
  const y1 = Math.min(level.height, Math.ceil((level.north - south) / level.pxLat))

  if (x1 <= x0 || y1 <= y0) return null
  return [x0, y0, x1, y1]
}

/**
 * Read the finest level whose window fits the cell budget.
 *
 * Dropping to an overview costs accuracy — a coarser cell averages roof and
 * eaves together — but it is the difference between an approximate height and
 * none at all on a 10 cm survey raster. Returns null when even the coarsest
 * level is too large, or when the bbox misses the raster entirely.
 */
async function readTile(grid, bbox, signal) {
  for (const level of grid.levels) {
    const window = windowFor(level, bbox)
    if (!window) return null // same bbox at every level, so no overlap anywhere

    const [x0, y0, x1, y1] = window
    const width = x1 - x0
    const height = y1 - y0
    if (width * height > MAX_WINDOW_CELLS) continue

    const bands = await level.image.readRasters({ window, samples: [0], signal })
    const raw = bands[0]
    const values = new Float32Array(width * height)

    // Normalise every flavour of "no data" to NaN, so the percentile maths has
    // exactly one thing to skip.
    for (let index = 0; index < values.length; index += 1) {
      const value = raw[index]
      values[index] = Number.isFinite(value) && value !== level.nodata ? value : NaN
    }

    return {
      values,
      x0,
      y0,
      width,
      height,
      west: level.west,
      north: level.north,
      pxLon: level.pxLon,
      pxLat: level.pxLat,
      name: grid.layer.name,
    }
  }

  return null
}

const colOf = (tile, lon) => (lon - tile.west) / tile.pxLon - tile.x0
const rowOf = (tile, lat) => (tile.north - lat) / tile.pxLat - tile.y0
const lonAt = (tile, col) => tile.west + (tile.x0 + col + 0.5) * tile.pxLon
const latAt = (tile, row) => tile.north - (tile.y0 + row + 0.5) * tile.pxLat

function valueAt(tile, col, row) {
  if (col < 0 || row < 0 || col >= tile.width || row >= tile.height) return NaN
  return tile.values[row * tile.width + col]
}

/** Nearest-cell lookup by coordinate — how the DEM is read against the DSM's cells. */
const sampleAt = (tile, lon, lat) => valueAt(
  tile,
  Math.floor(colOf(tile, lon)),
  Math.floor(rowOf(tile, lat)),
)

/**
 * Dilate a boolean mask by `radius` cells, Chebyshev — the ring's outer edge.
 *
 * Separable: a max over each row, then a max over each column of that. Two
 * linear passes instead of the (2r+1)² neighbourhood scan, which matters
 * because this runs once per footprint.
 */
function dilate(mask, width, height, radius) {
  const rows = new Uint8Array(width * height)

  for (let row = 0; row < height; row += 1) {
    const base = row * width
    for (let col = 0; col < width; col += 1) {
      const from = Math.max(0, col - radius)
      const to = Math.min(width - 1, col + radius)
      let hit = 0
      for (let scan = from; scan <= to && !hit; scan += 1) hit = mask[base + scan]
      rows[base + col] = hit
    }
  }

  const out = new Uint8Array(width * height)

  for (let col = 0; col < width; col += 1) {
    for (let row = 0; row < height; row += 1) {
      const from = Math.max(0, row - radius)
      const to = Math.min(height - 1, row + radius)
      let hit = 0
      for (let scan = from; scan <= to && !hit; scan += 1) hit = rows[scan * width + col]
      out[row * width + col] = hit
    }
  }

  return out
}

/**
 * Shoelace area in m², through a local equirectangular scale — see the header.
 *
 * Coordinates are made relative to the ring's first vertex before scaling.
 * Scaling degrees directly would put ~2e6 into every term of a sum whose answer
 * is ~1e2, and a shoelace over near-identical large numbers is the textbook way
 * to lose the answer to cancellation.
 */
function ringAreaM2(ring, originLat) {
  const scaleLon = metresPerDegreeLon(originLat)
  const [baseLon, baseLat] = ring[0]
  let sum = 0

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const x1 = (ring[j][0] - baseLon) * scaleLon
    const y1 = (ring[j][1] - baseLat) * METRES_PER_DEGREE_LAT
    const x2 = (ring[i][0] - baseLon) * scaleLon
    const y2 = (ring[i][1] - baseLat) * METRES_PER_DEGREE_LAT
    sum += x1 * y2 - x2 * y1
  }

  return Math.abs(sum) / 2
}

/**
 * Cells covered by one ring, plus the cells of its surrounding ground ring.
 *
 * Pushes elevations into the caller's accumulators rather than returning them,
 * because a MultiPolygon's parts are measured as one building — the Python
 * hands the whole geometry to one geometry_mask, and splitting it here would
 * give a courtyard block four separate heights.
 */
function accumulateRing(ring, dsmTile, groundTile, radius, sink) {
  const pixels = ring.map(([lon, lat]) => [colOf(dsmTile, lon), rowOf(dsmTile, lat)])

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const [x, y] of pixels) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }

  if (!Number.isFinite(minX)) return

  const x0 = Math.max(0, Math.floor(minX) - radius)
  const x1 = Math.min(dsmTile.width, Math.ceil(maxX) + radius + 1)
  const y0 = Math.max(0, Math.floor(minY) - radius)
  const y1 = Math.min(dsmTile.height, Math.ceil(maxY) + radius + 1)

  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0 || height <= 0 || width * height > MAX_FOOTPRINT_CELLS) return

  const inside = new Uint8Array(width * height)
  let insideCount = 0

  for (let row = 0; row < height; row += 1) {
    const centreY = y0 + row + 0.5
    for (let col = 0; col < width; col += 1) {
      if (ringContains(pixels, x0 + col + 0.5, centreY)) {
        inside[row * width + col] = 1
        insideCount += 1
      }
    }
  }

  // No cell centre fell inside: the building is smaller than one cell. The
  // Python re-runs the mask with all_touched for exactly this case rather than
  // dropping the row, so take the cells the footprint's extent covers.
  if (insideCount === 0) {
    const tx0 = Math.max(x0, Math.floor(minX))
    const tx1 = Math.min(x1, Math.ceil(maxX) + 1)
    const ty0 = Math.max(y0, Math.floor(minY))
    const ty1 = Math.min(y1, Math.ceil(maxY) + 1)

    for (let row = ty0; row < ty1; row += 1) {
      for (let col = tx0; col < tx1; col += 1) {
        inside[(row - y0) * width + (col - x0)] = 1
        insideCount += 1
      }
    }
  }

  if (insideCount === 0) return

  sink.cells += insideCount

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!inside[row * width + col]) continue
      const value = valueAt(dsmTile, x0 + col, y0 + row)
      if (Number.isFinite(value)) sink.roof.push(value)

      // Only meaningful with a real DEM: on the DSM this reads the roof.
      if (groundTile !== dsmTile) {
        const under = sampleAt(groundTile, lonAt(dsmTile, x0 + col), latAt(dsmTile, y0 + row))
        if (Number.isFinite(under)) sink.groundUnder.push(under)
      }
    }
  }

  const ringMask = dilate(inside, width, height, radius)

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const index = row * width + col
      if (!ringMask[index] || inside[index]) continue
      const value = sampleAt(groundTile, lonAt(dsmTile, x0 + col), latAt(dsmTile, y0 + row))
      if (Number.isFinite(value)) sink.ground.push(value)
    }
  }
}

/**
 * Measure one footprint. Returns the property patch, or null when the surface
 * does not usably cover it — null rather than a confident-looking 0 m, which is
 * the same distinction the `height_m: null` rows from LiDAR carry.
 */
function measureFeature(feature, dsmTile, groundTile) {
  const rings = outerRings(feature.geometry).filter((ring) => Array.isArray(ring) && ring.length >= 4)
  if (rings.length === 0) return null

  let latSum = 0
  let latCount = 0

  for (const ring of rings) {
    for (const [, lat] of ring) {
      latSum += lat
      latCount += 1
    }
  }

  const centreLat = latSum / latCount
  const cellMetresX = dsmTile.pxLon * metresPerDegreeLon(centreLat)
  const cellMetresY = dsmTile.pxLat * METRES_PER_DEGREE_LAT

  // At least one cell, or a raster coarser than the ring width would dilate by
  // nothing and leave no ground to sample.
  const radius = Math.max(1, Math.round(RING_M / Math.max(cellMetresX, cellMetresY)))

  const sink = { cells: 0, roof: [], ground: [], groundUnder: [] }
  for (const ring of rings) accumulateRing(ring, dsmTile, groundTile, radius, sink)

  if (sink.cells === 0) return null

  const coverage = sink.roof.length / sink.cells
  const area = rings.reduce((total, ring) => total + ringAreaM2(ring, centreLat), 0)

  const unmeasured = {
    ground_m: null,
    roof_m: null,
    height_m: null,
    footprint_area_m2: round(area, 3),
    volume_prism_m3: null,
    volume_dsm_m3: null,
    coverage: round(coverage, 4),
    cell_count: sink.cells,
    height_source: null,
  }

  if (sink.roof.length === 0 || coverage < MIN_COVERAGE) return unmeasured

  // The ring first; the cells under the footprint only as a fallback, and only
  // when they come from a real DEM. Ground read from a DSM's own interior is
  // the roof, which would report every building as flat.
  let groundValues = sink.ground
  if (groundValues.length === 0) groundValues = sink.groundUnder
  if (groundValues.length === 0) return unmeasured

  const ground = percentile(groundValues.slice().sort((a, b) => a - b), GROUND_PERCENTILE)
  const roof = percentile(sink.roof.slice().sort((a, b) => a - b), ROOF_PERCENTILE)
  if (!Number.isFinite(ground) || !Number.isFinite(roof)) return unmeasured

  const height = Math.max(roof - ground, 0)

  // Integrated under the roof surface, so a pitched roof is not billed as a
  // flat prism. Compared against volume_prism_m3 the two agree on flat roofs
  // and diverge on pitched ones — the same free correctness signal the LiDAR
  // rows carry.
  //
  // The mean rise times the polygon's own area, where building_heights.py sums
  // cells and multiplies by cell area. The two agree wherever the cells tile
  // the footprint, and this one does not blow up where they do not: a footprint
  // smaller than one cell is measured through the all_touched fallback, so
  // cell-count x cell-area bills a 0.4 m shed on a 1 m grid for 25x its own
  // plan. On a 30 m national DEM that is every building in the extract, and the
  // quartile ramp both views colour by is derived from these volumes.
  let above = 0
  for (const value of sink.roof) above += Math.max(value - ground, 0)
  const meanRise = above / sink.roof.length

  return {
    ground_m: round(ground, 3),
    roof_m: round(roof, 3),
    height_m: round(height, 3),
    footprint_area_m2: round(area, 3),
    volume_prism_m3: round(area * height, 3),
    volume_dsm_m3: round(meanRise * area, 3),
    coverage: round(coverage, 4),
    cell_count: sink.cells,
    height_source: 'geotiff',
  }
}

/** Union of every ring in `features`, as an API-order bbox. */
function unionBbox(features) {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  for (const feature of features) {
    for (const ring of outerRings(feature.geometry)) {
      for (const [lon, lat] of ring) {
        west = Math.min(west, lon); east = Math.max(east, lon)
        south = Math.min(south, lat); north = Math.max(north, lat)
      }
    }
  }

  return Number.isFinite(west) ? [west, south, east, north] : null
}

function intersectBbox(a, b) {
  const west = Math.max(a[0], b[0])
  const south = Math.max(a[1], b[1])
  const east = Math.min(a[2], b[2])
  const north = Math.min(a[3], b[3])
  return east > west && north > south ? [west, south, east, north] : null
}

/**
 * Fill in the heights `/gis/buildings` could not measure, from a GeoTIFF.
 *
 * Never throws and never mutates its input: on any failure — no elevation layer
 * uploaded, a CORS-blocked bucket, a raster too coarse to window — it returns
 * the features it was given and a note for the caption. A missing height is a
 * normal state for this map, so it must not be able to take the buildings layer
 * down with it.
 *
 * Returns `{ features, filled, unmeasured, note, layerName, groundFromSurface }`.
 */
export async function fillHeightsFromGeotiff(features, { apiBaseUrl, bbox, signal } = {}) {
  const idle = { features, filled: 0, unmeasured: 0, note: null, layerName: null, groundFromSurface: false }

  const pending = (features ?? []).filter((feature) => {
    const height = feature?.properties?.height_m
    return height === null || height === undefined
  })

  if (pending.length === 0) return idle

  const measurable = pending.slice(0, MAX_FEATURES)

  try {
    const query = new URLSearchParams({
      layer_type: 'tiff',
      kind: 'dsm,dem',
      geometry_class: 'raster',
      limit: '50',
    })

    // Scoped to the area in question when the caller has one, so a library with
    // rasters all over the country does not hand back fifty irrelevant layers.
    const area = bbox ?? unionBbox(measurable)
    if (area) query.set('bbox', area.join(','))

    const response = await fetch(`${apiBaseUrl}/gis/layers?${query}`, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const { dsm, dem } = pickElevationLayers((await response.json()).layers)
    if (!dsm) return idle

    const grid = await openGrid(dsm)
    const window = area ? intersectBbox(area, grid.bounds) : grid.bounds
    if (!window) return idle

    const dsmTile = await readTile(grid, window, signal)
    if (!dsmTile) {
      return {
        ...idle,
        note: `${dsm.name} is too finely gridded to sample here — zoom in for GeoTIFF heights.`,
      }
    }

    let groundTile = dsmTile

    if (dem) {
      const demGrid = await openGrid(dem)
      const demWindow = intersectBbox(window, demGrid.bounds)
      // A DEM that fails to read is not fatal: the DSM ring still gives a
      // ground datum, so fall through rather than losing every height.
      if (demWindow) groundTile = (await readTile(demGrid, demWindow, signal)) ?? dsmTile
    }

    const patches = new Map()
    let filled = 0

    for (const feature of measurable) {
      const patch = measureFeature(feature, dsmTile, groundTile)
      // Only a patch that actually carries a height is merged. A footprint this
      // raster could not cover either already has the LiDAR row's own
      // `coverage` and `footprint_area_m2`, and overwriting those with ours
      // would replace one source's numbers with another's for no gain.
      if (!patch || patch.height_m === null) continue
      patches.set(feature, patch)
      filled += 1
    }

    if (filled === 0) return { ...idle, layerName: dsm.name }

    return {
      features: features.map((feature) => {
        const patch = patches.get(feature)
        if (!patch) return feature
        return { ...feature, properties: { ...feature.properties, ...patch } }
      }),
      filled,
      unmeasured: measurable.length - filled,
      note: null,
      layerName: dsm.name,
      groundFromSurface: groundTile === dsmTile,
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error

    // A cross-origin range request rejects as a bare TypeError, which reads as
    // a frontend bug when it is a bucket CORS setting.
    return {
      ...idle,
      note: error instanceof TypeError
        ? 'GeoTIFF heights unavailable — the raster bucket does not allow range requests from this origin.'
        : `GeoTIFF heights unavailable — ${error?.message ?? 'could not read the raster'}.`,
    }
  }
}
