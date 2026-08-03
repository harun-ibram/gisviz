/**
 * API `bounds` is x-y order:              [minLon, minLat, maxLon, maxLat]
 * Leaflet LatLngBounds is y-x, SW then NE: [[minLat, minLon], [maxLat, maxLon]]
 * A swap of each pair AND a regroup — not a reverse of the array.
 *
 *   API      [25.9612, 44.3312, 26.2231, 44.5510]   Bucharest
 *   Leaflet  [[44.3312, 25.9612], [44.5510, 26.2231]]
 *
 * Get it wrong and Bucharest (44.4N, 26.1E) renders at 26.1N, 44.4E — the Saudi
 * desert. That off-by-a-continent is the acceptance test.
 *
 * This is the ONLY export in the codebase that produces Leaflet-order data, and
 * Leaflet-order bounds are never stored in the provider. Exactly three call
 * sites consume it: `<ImageOverlay bounds>`, `map.fitBounds` and `<Rectangle
 * bounds>`. Everything else — including `bounds_geojson` and fetched
 * FeatureCollections — stays lon/lat, which Leaflet's GeoJSON layer handles
 * itself.
 */
export function toLeafletBounds(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 4) {
        return null
    }

    const [minLon, minLat, maxLon, maxLat] = bounds.map(Number)

    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
        return null
    }

    // A backend that ever emits them the wrong way round should still draw
    // rather than silently vanish, so normalise instead of trusting the order.
    let south = Math.min(minLat, maxLat)
    let north = Math.max(minLat, maxLat)
    let west = Math.min(minLon, maxLon)
    let east = Math.max(minLon, maxLon)

    if (Math.abs(south) > 90 || Math.abs(north) > 90) {
        return null
    }

    // A single-point GeoJSON gives a zero-area box, which Leaflet fits at
    // maximum zoom over nothing. Pad it into something viewable.
    const PAD = 1e-4

    if (north - south < PAD) {
        south -= PAD
        north += PAD
    }

    if (east - west < PAD) {
        west -= PAD
        east += PAD
    }

    return [[south, west], [north, east]]
}

/** Union of Leaflet-order bounds — used to fit to every layer one job produced. */
export function unionLeafletBounds(boundsList) {
    const valid = boundsList.filter(Boolean)

    if (valid.length === 0) {
        return null
    }

    let south = Infinity
    let west = Infinity
    let north = -Infinity
    let east = -Infinity

    for (const [[s, w], [n, e]] of valid) {
        south = Math.min(south, s)
        west = Math.min(west, w)
        north = Math.max(north, n)
        east = Math.max(east, e)
    }

    return [[south, west], [north, east]]
}

/**
 * The inverse of the swap above: the `/gis/layers?bbox=` query wants API order,
 * so read the Leaflet bounds object back out component-wise rather than
 * flattening it.
 */
export function mapBoundsToApiBbox(leafletBounds) {
    if (!leafletBounds) {
        return null
    }

    return [
        leafletBounds.getWest(),
        leafletBounds.getSouth(),
        leafletBounds.getEast(),
        leafletBounds.getNorth(),
    ]
}

/** The 5-stop terrain LUT `scripts/gis/gis_common.py` colourises rasters with. */
export const TERRAIN_RAMP = ['#2c5e8f', '#3f8f6e', '#c9c06a', '#a4693f', '#f2f2f2']

export function rampCss(stops = TERRAIN_RAMP) {
    return `linear-gradient(to right, ${stops.join(', ')})`
}

/** Accent-derived palette for vector sublayers. */
export const VECTOR_COLORS = {
    buildings: '#b5abfc',
    roads: '#9690c9',
    features: '#8fb9d9',
}

export function vectorColor(sublayer) {
    return VECTOR_COLORS[sublayer] ?? VECTOR_COLORS.features
}

export function isRasterLayer(layer) {
    return layer?.geometry_class === 'raster'
}

export function isVectorLayer(layer) {
    return layer?.geometry_class === 'vector'
}
