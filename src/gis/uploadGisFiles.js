import { EXPIRED_UPLOAD_MESSAGE } from './gisErrors.js'

// Lower than the photo flow's 6: these files are huge and four concurrent
// multi-hundred-megabyte PUTs already saturate most uplinks.
const UPLOAD_CONCURRENCY = 4
const MAX_ATTEMPTS = 3

export class GisUploadError extends Error {
    constructor(message, { status = 0, expired = false } = {}) {
        super(message)
        this.name = 'GisUploadError'
        this.status = status
        this.expired = expired
    }
}

/**
 * Upload.jsx uses fetch(), which is correct for many small photos but wrong
 * here — a single 500 MB .laz would give zero feedback for minutes. XHR is the
 * only way to get upload progress in the browser.
 */
function putOne({ file, url, onBytes, signal }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        const abort = () => xhr.abort()

        if (signal?.aborted) {
            reject(new DOMException('Upload aborted', 'AbortError'))
            return
        }

        signal?.addEventListener('abort', abort, { once: true })

        const settle = (fn) => (value) => {
            signal?.removeEventListener('abort', abort)
            fn(value)
        }

        const done = settle(resolve)
        const fail = settle(reject)

        xhr.open('PUT', url, true)

        // .tif and .laz usually come through with file.type === '', and sending
        // an empty Content-Type makes R2 reject the signature. If R2 ever
        // returns 403 SignatureDoesNotMatch, drop this header entirely.
        if (file.type) {
            xhr.setRequestHeader('Content-Type', file.type)
        }

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                onBytes(event.loaded)
            }
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                onBytes(file.size)
                done()
                return
            }

            fail(new GisUploadError(
                xhr.status === 403
                    ? EXPIRED_UPLOAD_MESSAGE
                    : `Upload failed for ${file.name} (${xhr.status})`,
                { status: xhr.status, expired: xhr.status === 403 },
            ))
        }

        xhr.onerror = () => fail(new GisUploadError(`Upload failed for ${file.name} — network error`))
        xhr.ontimeout = () => fail(new GisUploadError(`Upload timed out for ${file.name}`))
        xhr.onabort = () => fail(new DOMException('Upload aborted', 'AbortError'))

        xhr.send(file)
    })
}

/**
 * Bounded-concurrency PUT pool with aggregated per-byte progress across the
 * pool, so the caller can render "Uploading 214 MB / 498 MB (43%)".
 *
 * Retries twice on network errors and 5xx, never on 4xx — a 4xx is a bad
 * signature or an expired link and retrying just burns time.
 */
export async function uploadGisFiles({ files, uploadUrls, onProgress, signal }) {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

    // Per-file loaded counts, so a retry that restarts one file at 0 can't make
    // the aggregate total go backwards past what the others have done.
    const loaded = new Map(files.map((file) => [file.name, 0]))

    const report = () => {
        let sum = 0

        for (const bytes of loaded.values()) {
            sum += bytes
        }

        onProgress?.({ loadedBytes: sum, totalBytes })
    }

    report()

    let nextIndex = 0

    const uploadWithRetry = async (file) => {
        const url = uploadUrls?.[file.name]

        if (!url) {
            throw new GisUploadError(`No upload URL was issued for ${file.name}`)
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                await putOne({
                    file,
                    url,
                    signal,
                    onBytes: (bytes) => {
                        loaded.set(file.name, bytes)
                        report()
                    },
                })

                return
            } catch (error) {
                if (error?.name === 'AbortError') {
                    throw error
                }

                const status = error?.status ?? 0
                const retriable = status === 0 || status >= 500

                if (!retriable || attempt === MAX_ATTEMPTS) {
                    throw error
                }

                loaded.set(file.name, 0)
                report()

                await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
            }
        }
    }

    const worker = async () => {
        while (nextIndex < files.length) {
            if (signal?.aborted) {
                throw new DOMException('Upload aborted', 'AbortError')
            }

            const file = files[nextIndex]
            nextIndex += 1
            await uploadWithRetry(file)
        }
    }

    const workerCount = Math.min(UPLOAD_CONCURRENCY, files.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
}
