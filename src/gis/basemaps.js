/**
 * Tile layers shared by the GIS page and the viewer's location map.
 *
 * Lifted out of GisMap.jsx so both maps stay on the same basemaps and the same
 * attribution; GisMap still carries its own copy and can adopt this later.
 *
 * `osm` deliberately omits the `{s}` subdomain placeholder — the OSM tile usage
 * policy asks clients not to shard across a/b/c — and caps `maxNativeZoom` below
 * `maxZoom` so a metre-scale layer can still be inspected past tile coverage.
 */
export const BASEMAPS = {
  dark: {
    id: 'dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  osm: {
    id: 'osm',
    label: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  },
}

/** Centre of Romania — where the map opens before any feature is known. */
export const DEFAULT_CENTER = [45.9432, 24.9668]
export const DEFAULT_ZOOM = 6
