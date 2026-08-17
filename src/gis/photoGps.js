import exifr from 'exifr'

/**
 * Read the GPS tags out of the photos being uploaded.
 *
 * Points come back in API order — [lon, lat] — like every other coordinate in
 * this app; see the header on gisGeo.js. A photo with no GPS is a null, not an
 * error: most sets have a few.
 *
 * exifr.gps() reads only the header slice rather than the whole file, and
 * applies the GPSLatitudeRef/GPSLongitudeRef hemisphere signs, which is the
 * part a hand-rolled IFD walker gets wrong. `gpu/splat_app.py` has the Python
 * equivalent (_exif_gps) for the georeferencing pass that GS2Mesh dropped.
 */

// Six decimals is ~0.1 m, matching the drawing picker's own precision. A
// consumer GPS fix is nowhere near that good, so anything past it is noise.
const PRECISION = 6

// Reading a header slice is cheap, but it is still a disk read and a parse per
// file, and a drone set runs to hundreds of photos. Same shape as the upload
// queue: enough in flight to stay busy, not enough to thrash.
const SCAN_CONCURRENCY = 8

const round = (value) => Number(value.toFixed(PRECISION))

/** The key Upload.jsx already dedupes files on, so nothing is scanned twice. */
export const fileKey = (file) => `${file.name}:${file.size}`

/**
 * One photo's location as [lon, lat], or null when it has none worth trusting.
 *
 * A camera that writes the GPS block without ever getting a fix leaves it at
 * exactly 0/0. That is a real place in the Gulf of Guinea, but it is never
 * where the photo was taken, and one such file would drag a hull across two
 * continents — so it is dropped along with the malformed values.
 */
export async function readGps(file) {
    let gps

    try {
        gps = await exifr.gps(file)
    } catch {
        // A truncated file, an unsupported container, an EXIF block that does
        // not parse: all "no location", none of them worth failing an upload.
        return null
    }

    if (!gps) {
        return null
    }

    const lat = Number(gps.latitude)
    const lon = Number(gps.longitude)

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null
    }

    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return null
    }

    if (lat === 0 && lon === 0) {
        return null
    }

    return [round(lon), round(lat)]
}

/**
 * Scan a list of files, keyed by fileKey.
 *
 * Returns `{ [key]: [lon, lat] | null }` — every file gets an entry, so the
 * caller can tell "scanned, has none" from "not scanned yet" and never reads
 * the same file twice.
 */
export async function readGpsPoints(files, onProgress) {
    const found = {}
    let nextIndex = 0
    let settled = 0

    // Workers pull from one shared queue; claiming an index and advancing it is
    // a single synchronous step, so no two workers take the same file. Lifted
    // from uploadFilesInBatches in Upload.jsx, which does the same for PUTs.
    const worker = async () => {
        while (nextIndex < files.length) {
            const file = files[nextIndex]
            nextIndex += 1

            found[fileKey(file)] = await readGps(file)

            settled += 1
            onProgress?.(settled, files.length)
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, worker),
    )

    return found
}
