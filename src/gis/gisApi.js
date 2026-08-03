export class GisApiError extends Error {
    constructor(message, { status = 0, detail = '', kind = 'http' } = {}) {
        super(message)
        this.name = 'GisApiError'
        this.status = status
        this.detail = detail
        this.kind = kind
    }
}

// A cross-origin or offline fetch rejects with a TypeError carrying no status,
// which otherwise reads to the user as "the app is broken".
const NETWORK_MESSAGE = 'Could not reach the backend. Check that it is running and reachable.'

async function request(url, options = {}) {
    let response

    try {
        response = await fetch(url, options)
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw error
        }

        throw new GisApiError(NETWORK_MESSAGE, { kind: 'network' })
    }

    if (!response.ok) {
        // The backend writes user-grade strings into `detail`; surface them
        // verbatim rather than inventing our own copy.
        let detail = ''

        try {
            const body = await response.json()

            if (typeof body?.detail === 'string') {
                detail = body.detail
            }
        } catch {
            // A non-JSON error body just means there is no detail to show.
        }

        throw new GisApiError(detail || `Request failed (${response.status})`, {
            status: response.status,
            detail,
        })
    }

    if (response.status === 204) {
        return null
    }

    return response.json()
}

const jsonBody = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
})

function buildQuery(params) {
    const search = new URLSearchParams()

    for (const [key, value] of Object.entries(params)) {
        if (value == null || value === '') {
            continue
        }

        search.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }

    const query = search.toString()
    return query ? `?${query}` : ''
}

/**
 * One function per endpoint in GIS_PLAN.md §6. `apiBaseUrl` comes from
 * useSplatLibrary() — this module never reads import.meta.env.
 */
export function makeGisApi(apiBaseUrl) {
    const base = `${apiBaseUrl}/gis`

    return {
        getConfig: (signal) => request(`${base}/config`, { signal }),

        createJob: ({ layerType, name, files, options }) => request(`${base}/jobs`, jsonBody({
            layer_type: layerType,
            name,
            files: files.map((file) => ({ filename: file.name, size_bytes: file.size })),
            options,
        })),

        startJob: (jobId) => request(`${base}/jobs/${jobId}/start`, { method: 'POST' }),

        getJob: (jobId, signal) => request(`${base}/jobs/${jobId}`, { signal }),

        listJobs: (params = {}, signal) => request(`${base}/jobs${buildQuery(params)}`, { signal }),

        deleteJob: (jobId) => request(`${base}/jobs/${jobId}`, { method: 'DELETE' }),

        listLayers: (params = {}, signal) => request(`${base}/layers${buildQuery(params)}`, { signal }),

        getLayer: (layerId, signal) => request(`${base}/layers/${layerId}`, { signal }),

        deleteLayer: (layerId) => request(`${base}/layers/${layerId}`, { method: 'DELETE' }),

        getAssetUrl: (key, signal) => request(`${base}/asset-url${buildQuery({ key })}`, { signal }),
    }
}
