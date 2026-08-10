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
 * `volume_lidar_m3` integrates each raster cell under the roof; `volume_prism_m3`
 * is area x height. The former is the better number, so it wins where both are
 * present. Null means the LiDAR never usably covered this footprint.
 */
export function volumeOf(properties) {
  return properties?.volume_lidar_m3 ?? properties?.volume_prism_m3 ?? null
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
