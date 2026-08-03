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

export const formatCoordinateSummary = (geometry) => {
    const coordinatePairs = collectCoordinatePairs(geometry?.coordinates)

    if (coordinatePairs.length === 0) {
        return 'Coordinates unavailable'
    }

    const [longitudeSum, latitudeSum] = coordinatePairs.reduce(
        (accumulator, [longitude, latitude]) => [
            accumulator[0] + longitude,
            accumulator[1] + latitude,
        ],
        [0, 0],
    )

    const longitude = longitudeSum / coordinatePairs.length
    const latitude = latitudeSum / coordinatePairs.length

    return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
}

export const decorateSplat = (type, { key, name, modelPath, geom }) => ({
    key,
    type,
    name,
    modelPath,
    coords: formatCoordinateSummary(geom),
    format: modelPath ? `.${getFileExtension(modelPath)}` : '—',
})
