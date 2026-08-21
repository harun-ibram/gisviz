import { getFileExtension } from "../utils"

export const collectCoordinatePairs = (coordinates, pairs = []) => {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return pairs
    }

    if (typeof coordinates[0] === 'number') {
        const [longitude, latitude] = coordinates
        pairs.push([longitude, latitude])
        return pairs
    }

    coordinates.forEach((nestedCoordinates) => {
        collectCoordinatePairs(nestedCoordinates, pairs)
    })

    return pairs
}

/** Mean of every position in the geometry — good enough to label a row with. */
const centroidOf = (geometry) => {
    const coordinatePairs = collectCoordinatePairs(geometry?.coordinates)

    if (coordinatePairs.length === 0) {
        return null
    }

    const [longitudeSum, latitudeSum] = coordinatePairs.reduce(
        (accumulator, [longitude, latitude]) => [
            accumulator[0] + longitude,
            accumulator[1] + latitude,
        ],
        [0, 0],
    )

    return {
        longitude: longitudeSum / coordinatePairs.length,
        latitude: latitudeSum / coordinatePairs.length,
        count: coordinatePairs.length,
    }
}

export const formatCoordinateSummary = (geometry) => {
    const centre = centroidOf(geometry)

    if (!centre) {
        return 'Coordinates unavailable'
    }

    return `${centre.latitude.toFixed(5)}, ${centre.longitude.toFixed(5)}`
}

/**
 * The same centre, written the way a chart does it — "50.9413° N, 6.9583° E".
 * Signed decimals are what the detail panel shows; the list wants the hemisphere
 * spelled out, because that is the part you scan for.
 */
export const formatCompassCoordinates = (geometry) => {
    const centre = centroidOf(geometry)

    if (!centre) {
        return null
    }

    const northSouth = centre.latitude >= 0 ? 'N' : 'S'
    const eastWest = centre.longitude >= 0 ? 'E' : 'W'

    return `${Math.abs(centre.latitude).toFixed(4)}° ${northSouth}, `
        + `${Math.abs(centre.longitude).toFixed(4)}° ${eastWest}`
}

export const decorateSplat = (type, { key, id, name, modelPath, geom }) => ({
    key,
    id: id ?? null,
    type,
    name,
    modelPath,
    coords: formatCoordinateSummary(geom),
    compass: formatCompassCoordinates(geom),
    format: modelPath ? `.${getFileExtension(modelPath)}` : '—',
    geometryType: geom?.type ?? null,
    // Labelled "vertices" in the UI: for an area it is the outline's corners,
    // for a node the single position.
    vertexCount: collectCoordinatePairs(geom?.coordinates).length,
    // Nothing in the API reports a pipeline state, so the only honest status is
    // "is there a model behind this row".
    status: modelPath ? 'ready' : 'pending',
})
