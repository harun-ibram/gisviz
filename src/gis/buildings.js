/**
 * Shared building helpers.
 *
 * These were duplicated verbatim between SplatViewer (3D) and OSMViewer (SVG),
 * and the two copies had already drifted: `classOf` returned 0 for an unknown
 * volume in one and null in the other. This module is the single definition;
 * palettes live next door in gisGeo.js.
 */

/**
 * Outer rings of a Polygon or MultiPolygon.
 *
 * Holes are dropped: neither an extrusion nor a 2.5D SVG fake does anything
 * useful with them, and carrying them would silently change the area both
 * views report.
 */
export function outerRings(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((part) => part[0])
  return []
}

/**
 * The volume to colour a building by.
 *
 * `volume_lidar_m3` and `volume_dsm_m3` both integrate each raster cell under
 * the roof — the first from the LiDAR grid the backend measured, the second
 * from a GeoTIFF surface sampled in the browser (see gis/geotiffHeights.js).
 * `volume_prism_m3` is area x height, which averages a pitched roof away, so
 * either integrated figure wins over it. Null means no elevation source has
 * usably covered this footprint.
 *
 * LiDAR first where both exist: a building only ever gets the GeoTIFF pass
 * *because* LiDAR left it unmeasured, so the two never really compete — but
 * fixing the order here means a future re-measure cannot silently downgrade
 * the number a footprint is coloured by.
 */
export function volumeOf(properties) {
  return properties?.volume_lidar_m3
    ?? properties?.volume_dsm_m3
    ?? properties?.volume_prism_m3
    ?? null
}

/**
 * Which surface this footprint's height was measured against: 'lidar',
 * 'geotiff', or null when nothing measured it.
 *
 * `height_source` is stamped by the browser-side GeoTIFF pass; the rows
 * `/gis/buildings` returns carry no such field, so a height with no source is
 * a LiDAR height by elimination. Callers use this to say which number they are
 * showing rather than to decide whether to show one.
 */
export function heightSourceOf(properties) {
  const height = properties?.height_m
  if (height === null || height === undefined) return null
  return properties?.height_source ?? 'lidar'
}

/**
 * Quartile breaks over the volumes actually present.
 *
 * Data-driven rather than fixed thresholds: a village and a city centre would
 * otherwise collapse into a single class. Returns null when nothing is
 * measured, which callers must treat as "no classification available".
 */
export function volumeBreaks(volumes) {
  const sorted = volumes.filter((v) => v !== null && v > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  return [at(0.25), at(0.5), at(0.75)]
}

/**
 * Class index 0-3, or **null** when the volume is unknown.
 *
 * Null, not 0. The SplatViewer copy used to return 0, which filed "we don't
 * know" into "smallest class" — the same category error the no-data colour
 * exists to prevent. Callers branch on null explicitly.
 */
export function volumeClass(volume, breaks) {
  if (volume === null || volume === undefined || breaks === null) return null
  if (volume <= breaks[0]) return 0
  if (volume <= breaks[1]) return 1
  if (volume <= breaks[2]) return 2
  return 3
}

export function formatVolume(value) {
  if (value === null || value === undefined) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M m³`
  if (value >= 1000) return `${Math.round(value / 1000)}k m³`
  return `${Math.round(value)} m³`
}

export function formatMetres(value) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)} m`
}

/**
 * Is [lon, lat] inside this ring? Ray casting, lon/lat order.
 *
 * Used to decide which measured buildings fall inside a user's drawn outline.
 * Plane geometry on degrees, with no projection: over a footprint-sized ring
 * the error is far below the precision of a hand-drawn corner, and the ring is
 * closed implicitly by starting the walk at the last vertex.
 */
export function ringContains(ring, lon, lat) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    // Only edges that straddle the ray's latitude can cross it. The strict
    // inequality on one side is what stops a vertex exactly on the ray from
    // counting twice.
    const straddles = (yi > lat) !== (yj > lat)
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
