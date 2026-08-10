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

// ---------------------------------------------------------------------------
// Building volume ramp
//
// One sequential blue hue, four quantile classes, light -> dark. Two variants
// because a single ramp cannot serve both surfaces: the light set was picked
// against a parchment map, and on the viewer's near-black stage its darkest
// step measures 1.58:1 — invisible. The dark set is the same hue family lifted
// so the darkest still clears 2.91:1 on #07111f.
//
// Both index the same class list, so a building is "class 3" in either view and
// the two legends agree. Validated with the dataviz validator in --ordinal mode
// against each surface; re-run it if you touch these.
// ---------------------------------------------------------------------------

/** For light surfaces — the parchment SVG map. Surface #e8d8c0. */
export const VOLUME_RAMP_LIGHT_BG = ['#3987e5', '#256abf', '#184f95', '#0d366b']

/** Wall tones for the 2.5D fake, one step darker than each roof above. */
export const VOLUME_RAMP_LIGHT_BG_WALL = ['#1c5cab', '#104281', '#0d366b', '#0a2b57']

/** For dark surfaces — the 3D viewer stage and the dark basemap. Surface #07111f. */
export const VOLUME_RAMP_DARK_BG = ['#9ecbff', '#5ea5f2', '#3f7fd4', '#2a5da8']

export const VOLUME_CLASS_LABELS = ['smallest 25%', '25–50%', '50–75%', 'largest 25%']

/**
 * A footprint with no usable LiDAR cover. Deliberately off-ramp and
 * desaturated: absence of a measurement is not the bottom of the scale.
 */
export const NO_DATA_COLOUR = '#a8a49a'
export const NO_DATA_WALL = '#8b877d'

// Map markers. Orange = has a splat you can open, neutral = nothing generated
// yet. Mirrored as --gv-splat-point / --gv-empty-point in theme/nocturne.css,
// because CSS cannot import from here — keep the two in step.
export const SPLAT_POINT = '#eb6834'
export const EMPTY_POINT = '#b3a68f'
export const POINT_RING = '#111722'

export function isRasterLayer(layer) {
    return layer?.geometry_class === 'raster'
}

export function isVectorLayer(layer) {
    return layer?.geometry_class === 'vector'
}
