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
 * One of only two exports that produce Leaflet-order data — `ringToLatLngs`
 * below is the other, for drawn polygons — and Leaflet-order bounds are never
 * stored in the provider. Exactly three call sites consume this one:
 * `<ImageOverlay bounds>`, `map.fitBounds` and `<Rectangle bounds>`. Everything
 * else — including `bounds_geojson` and fetched FeatureCollections — stays
 * lon/lat, which Leaflet's GeoJSON layer handles itself.
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

/**
 * A [[lon, lat], ...] ring as Leaflet-order positions, for `<Polygon positions>`
 * and `<Polyline positions>`.
 *
 * The second and last Leaflet-order producer; see the header on
 * `toLeafletBounds`. Rings are stored lon/lat everywhere else, because that is
 * what GeoJSON and the API use.
 */
export function ringToLatLngs(ring) {
    return (ring ?? []).map(([lon, lat]) => [lat, lon])
}

/**
 * The server's own MAX_POLYGON_VERTICES, mirrored so a limit is felt while
 * drawing — or while a hull is derived — rather than reported after a failed
 * submit.
 */
export const MAX_POLYGON_VERTICES = 1000

/**
 * The convex hull of [[lon, lat], ...] points, by Andrew's monotone chain.
 *
 * Returns an *open* ring, the same shape a drawn outline has: the first
 * position is not repeated at the end, because the server closes it.
 * Collinear points are dropped — three points on a line enclose no area, and
 * PostGIS would reject the result anyway.
 *
 * `[]` when fewer than three corners survive, which is the caller's signal
 * that these photos cannot describe an area: every photo at one spot, two
 * spots, or a straight flight line.
 *
 * The hull is computed in raw lon/lat, so a set of photos straddling the
 * antimeridian produces a ring wrapped the long way round the planet. The
 * server's MAX_POLYGON_AREA_M2 check rejects that with a readable message
 * rather than storing it — worth knowing, not worth projecting for.
 */
export function convexHull(points) {
    const unique = [...new Map(
        (points ?? [])
            .filter((point) => Array.isArray(point) && point.length === 2)
            .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
            .map((point) => [`${point[0]},${point[1]}`, point]),
    ).values()]

    if (unique.length < 3) {
        return []
    }

    const sorted = [...unique].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))

    // > 0 is a left turn. Dropping the `=== 0` case too is what removes
    // collinear points from the hull.
    const cross = (o, a, b) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    const half = (ordered) => {
        const chain = []

        for (const point of ordered) {
            while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
                chain.pop()
            }
            chain.push(point)
        }

        // The last point of each half is the first of the other, so both are
        // dropped before the halves are joined.
        chain.pop()
        return chain
    }

    const hull = [...half(sorted), ...half([...sorted].reverse())]

    return hull.length >= 3 ? hull : []
}

/** The arithmetic mean of [[lon, lat], ...] points, or null for an empty list. */
export function meanPoint(points) {
    const valid = (points ?? []).filter(
        (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
    )

    if (valid.length === 0) {
        return null
    }

    const [lonSum, latSum] = valid.reduce(
        (total, [lon, lat]) => [total[0] + lon, total[1] + lat],
        [0, 0],
    )

    return [lonSum / valid.length, latSum / valid.length]
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

/**
 * Wall tones for the map's 2.5D fake — each roof above at 55% luminance.
 *
 * 55%, not the 68% that reads as natural shading: at 68% the darkest roof and
 * its wall sit 1.61:1 apart, which on a 220px map is not a fold, it is noise.
 * This gives 1.94:1. The darkest wall is then only 1.50:1 against the basemap —
 * dim on purpose, it is the shaded face — so the wall path also takes a
 * 1px stroke in its own roof colour, and that stroke is what keeps the
 * silhouette readable rather than the fill.
 */
export const VOLUME_RAMP_DARK_BG_WALL = ['#57708c', '#345b85', '#234675', '#17335c']

export const VOLUME_CLASS_LABELS = ['smallest 25%', '25–50%', '50–75%', 'largest 25%']

/**
 * A footprint no elevation source usably covered — neither LiDAR nor a
 * GeoTIFF surface. Deliberately off-ramp and desaturated: absence of a
 * measurement is not the bottom of the scale.
 */
export const NO_DATA_COLOUR = '#a8a49a'
export const NO_DATA_WALL = '#8b877d'

// Map markers. Orange = has a splat you can open, neutral = nothing generated
// yet. Mirrored as --gv-splat-point / --gv-empty-point in theme/nocturne.css,
// because CSS cannot import from here — keep the two in step.
export const SPLAT_POINT = '#eb6834'
export const EMPTY_POINT = '#b3a68f'
export const POINT_RING = '#111722'

/**
 * Wall tones for the map's 2.5D fake, matching VOLUME_RAMP_DARK_BG_WALL's
 * treatment: the surface colour at 55% luminance.
 *
 * A splat's own building is drawn in the marker colour rather than its volume
 * class. That is a deliberate loss of information — you can no longer read its
 * size off the map — in exchange for the one question actually being asked of
 * this map, which is "which of these is mine".
 */
export const SPLAT_POINT_WALL = '#81391d'
export const EMPTY_POINT_WALL = '#625b4e'

export function isRasterLayer(layer) {
    return layer?.geometry_class === 'raster'
}

export function isVectorLayer(layer) {
    return layer?.geometry_class === 'vector'
}
