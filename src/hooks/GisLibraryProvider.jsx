import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { GisLibraryContext } from './gisLibraryContext.js'
import { useSplatLibrary } from './useSplatLibrary.js'
import { makeGisApi } from '../gis/gisApi.js'
import { FALLBACK_GIS_CONFIG, serializeOptions } from '../gis/gisConfig.js'
import { isTerminal } from '../gis/gisErrors.js'
import { uploadGisFiles } from '../gis/uploadGisFiles.js'

const CONFIG_CACHE_KEY = 'gisviz:gis-config:v1'
const CONFIG_TTL_MS = 10 * 60 * 1000
const LAYER_PAGE_SIZE = 50
const DEFAULT_OPACITY = 85

// Re-sign this far ahead of expiry, so a request in flight when the clock runs
// out still carries a valid signature.
const URL_REFRESH_MARGIN_MS = 5 * 60 * 1000
const URL_SWEEP_INTERVAL_MS = 60_000

const FIRST_POLL_DELAY_MS = 1200

// Long jobs do not need second-by-second attention; back off as they age.
function pollDelay(elapsedMs) {
    if (elapsedMs < 60_000) {
        return 2000
    }

    if (elapsedMs < 300_000) {
        return 4000
    }

    return 8000
}

/** Live config wins per key, but a partial response still gets sane limits. */
function mergeConfig(fallback, live) {
    if (!live || typeof live !== 'object') {
        return fallback
    }

    const merged = { ...fallback, ...live }

    for (const key of Object.keys(fallback)) {
        const base = fallback[key]
        const next = live[key]

        if (base && typeof base === 'object' && !Array.isArray(base)
            && next && typeof next === 'object' && !Array.isArray(next)) {
            merged[key] = { ...base, ...next }
        }
    }

    return merged
}

function readCachedConfig() {
    try {
        const raw = sessionStorage.getItem(CONFIG_CACHE_KEY)

        if (!raw) {
            return null
        }

        const { config, cachedAt } = JSON.parse(raw)
        return { config, fresh: Date.now() - cachedAt < CONFIG_TTL_MS }
    } catch {
        return null
    }
}

function writeCachedConfig(config) {
    try {
        sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ config, cachedAt: Date.now() }))
    } catch {
        // A full or unavailable sessionStorage is not worth surfacing.
    }
}

/**
 * The poll loop and the upload progress callback write to the same job
 * concurrently, so a setState-with-spread race would drop upload progress.
 * A reducer serialises them.
 */
function jobsReducer(state, action) {
    switch (action.type) {
        case 'JOB_CREATED':
            return [{ ...action.job, upload: action.upload ?? null, localError: '' }, ...state]

        case 'JOB_PROGRESS':
            return state.map((job) => (job.job_id === action.jobId
                ? { ...job, upload: action.upload }
                : job))

        case 'JOB_POLLED':
            return state.map((job) => (job.job_id === action.job.job_id
                // Server fields win, but client-only fields (upload progress,
                // local errors) are not present in the response and must survive.
                ? { ...job, ...action.job, pollError: '' }
                : job))

        case 'JOB_FAILED':
            return state.map((job) => (job.job_id === action.jobId
                ? { ...job, localError: action.error, upload: null }
                : job))

        case 'JOB_POLL_ERROR':
            // Deliberately does not touch `status`: a flaky network is not a
            // failed job.
            return state.map((job) => (job.job_id === action.jobId
                ? { ...job, pollError: action.error }
                : job))

        case 'JOB_DISMISSED':
            return state.filter((job) => job.job_id !== action.jobId)

        default:
            return state
    }
}

export function GisLibraryProvider({ children }) {
    // The one permitted source of the base URL — this file never reads
    // import.meta.env.
    const { apiBaseUrl } = useSplatLibrary()
    const api = useMemo(() => makeGisApi(apiBaseUrl), [apiBaseUrl])

    // Read once at mount. State rather than a ref so nothing touches a ref
    // during render.
    const [cachedConfig] = useState(readCachedConfig)
    const [config, setConfig] = useState(() => mergeConfig(FALLBACK_GIS_CONFIG, cachedConfig?.config))
    const [configFallback, setConfigFallback] = useState(false)

    const [jobs, dispatch] = useReducer(jobsReducer, [])
    const [activeJobId, setActiveJobId] = useState(null)

    const [layers, setLayers] = useState([])
    const [layersLoading, setLayersLoading] = useState(true)
    const [layersError, setLayersError] = useState('')
    const [layersTotal, setLayersTotal] = useState(0)

    const [selectedLayerId, setSelectedLayerId] = useState(null)
    const [visibleLayerIds, setVisibleLayerIds] = useState([])
    const [opacityByLayer, setOpacityByLayer] = useState({})

    const [basemap, setBasemap] = useState('dark')
    const [userMoved, setUserMoved] = useState(false)
    // API order ([minLon, minLat, maxLon, maxLat]) — Leaflet-order bounds are
    // never stored here. See gisGeo.js.
    const [viewBbox, setViewBbox] = useState(null)
    const [fitRequest, setFitRequest] = useState(null)
    const [fitSuggestion, setFitSuggestion] = useState(null)

    const [featureFocus, setFeatureFocus] = useState(null)

    // Set by "clip to this view and re-run" on a layer too heavy to draw: it
    // switches the tab and prefills the bbox, but not the files — the source
    // file has to be picked again.
    const [jobPrefill, setJobPrefill] = useState(null)
    const prefillNonce = useRef(0)

    // The bbox draft itself stays in the upload panel; only a committed value
    // (on blur, or "use current view") lands here, so typing in a bbox field
    // never re-renders the map. API order.
    const [bboxPreview, setBboxPreview] = useState(null)

    const fitNonce = useRef(0)

    // File[] per job, kept in a ref rather than state: retry must survive a tab
    // switch remounting the panel, but files changing must never re-render the
    // map. Form drafts stay in GisUploadPanel.
    const jobFilesRef = useRef(new Map())
    const uploadAbortRef = useRef(new Map())
    const ingestedJobsRef = useRef(new Set())

    // Freshness metadata lives in a ref because only callbacks and effects read
    // it; the URL strings are mirrored into state because components render
    // them. Keeping both avoids reading a ref during render.
    const urlCacheRef = useRef(new Map()) // assetKey -> {url, issuedAt, ttlMs}
    const urlInFlightRef = useRef(new Map()) // assetKey -> Promise<string>
    const [urlsByKey, setUrlsByKey] = useState({})

    /* — config: stale-while-revalidate — */
    useEffect(() => {
        if (cachedConfig?.fresh) {
            return undefined
        }

        const controller = new AbortController()

        api.getConfig(controller.signal)
            .then((live) => {
                const merged = mergeConfig(FALLBACK_GIS_CONFIG, live)
                setConfig(merged)
                setConfigFallback(false)
                writeCachedConfig(live)
            })
            .catch((error) => {
                if (error?.name !== 'AbortError') {
                    // Submit stays enabled — the server is the real gate.
                    setConfigFallback(true)
                }
            })

        return () => controller.abort()
    }, [api, cachedConfig])

    /* — signed URLs — */

    /** Seeds the cache from a layer object, so the common case costs no request. */
    const seedAssetUrl = useCallback((key, url, expiresIn, issuedAt) => {
        if (!key || !url) {
            return
        }

        const existing = urlCacheRef.current.get(key)

        if (existing && existing.issuedAt >= (issuedAt ?? 0)) {
            return
        }

        urlCacheRef.current.set(key, {
            url,
            issuedAt: issuedAt ?? Date.now(),
            ttlMs: (expiresIn ?? config.url_ttl_seconds ?? 3600) * 1000,
        })

        setUrlsByKey((current) => (current[key] === url ? current : { ...current, [key]: url }))
    }, [config.url_ttl_seconds])

    /**
     * An in-flight Map dedupes concurrent refreshes for the same key — without
     * it a pan that re-renders twelve tiles fires twelve identical signings.
     */
    const getFreshAssetUrl = useCallback(async (key, { force = false } = {}) => {
        if (!key) {
            return null
        }

        const cached = urlCacheRef.current.get(key)
        const expiresAt = cached ? cached.issuedAt + cached.ttlMs : 0

        if (!force && cached && Date.now() < expiresAt - URL_REFRESH_MARGIN_MS) {
            return cached.url
        }

        const inFlight = urlInFlightRef.current.get(key)

        if (inFlight) {
            return inFlight
        }

        const promise = api.getAssetUrl(key)
            .then((response) => {
                urlCacheRef.current.set(key, {
                    url: response.url,
                    issuedAt: Date.now(),
                    ttlMs: (response.expires_in ?? config.url_ttl_seconds ?? 3600) * 1000,
                })

                setUrlsByKey((current) => ({ ...current, [key]: response.url }))
                return response.url
            })
            .finally(() => {
                urlInFlightRef.current.delete(key)
            })

        urlInFlightRef.current.set(key, promise)
        return promise
    }, [api, config.url_ttl_seconds])

    const assetKeysForLayer = useCallback((layer) => [
        layer.overlay_key,
        layer.geojson_key,
    ].filter(Boolean), [])

    // Proactive sweep, restricted to visible layers: a 200-layer library must
    // not re-sign 400 keys every hour for layers nobody is looking at.
    useEffect(() => {
        const sweep = () => {
            if (document.visibilityState !== 'visible') {
                return
            }

            const visible = new Set(visibleLayerIds)

            for (const layer of layers) {
                if (!visible.has(layer.layer_id)) {
                    continue
                }

                for (const key of assetKeysForLayer(layer)) {
                    const cached = urlCacheRef.current.get(key)

                    if (!cached || Date.now() >= cached.issuedAt + cached.ttlMs - URL_REFRESH_MARGIN_MS) {
                        getFreshAssetUrl(key).catch(() => {})
                    }
                }
            }
        }

        const timer = setInterval(sweep, URL_SWEEP_INTERVAL_MS)
        return () => clearInterval(timer)
    }, [layers, visibleLayerIds, assetKeysForLayer, getFreshAssetUrl])

    /* — layers — */

    /**
     * Merges by layer_id, matching the backend's ON CONFLICT DO UPDATE, and
     * stamps urlIssuedAt so the URL cache knows how old the signatures are.
     */
    const ingestLayers = useCallback((incoming, { autoShow = false } = {}) => {
        if (!incoming?.length) {
            return
        }

        const issuedAt = Date.now()
        const stamped = incoming.map((layer) => ({ ...layer, urlIssuedAt: issuedAt }))

        for (const layer of stamped) {
            seedAssetUrl(layer.overlay_key, layer.overlay_url, layer.url_expires_in, issuedAt)
            seedAssetUrl(layer.geojson_key, layer.geojson_url, layer.url_expires_in, issuedAt)
        }

        setLayers((current) => {
            const byId = new Map(current.map((layer) => [layer.layer_id, layer]))

            for (const layer of stamped) {
                byId.set(layer.layer_id, { ...byId.get(layer.layer_id), ...layer })
            }

            return [...byId.values()]
        })

        setOpacityByLayer((current) => {
            const next = { ...current }

            for (const layer of stamped) {
                if (!(layer.layer_id in next)) {
                    next[layer.layer_id] = DEFAULT_OPACITY
                }
            }

            return next
        })

        if (autoShow) {
            setVisibleLayerIds((current) => {
                const seen = new Set(current)
                return [...current, ...stamped.map((l) => l.layer_id).filter((id) => !seen.has(id))]
            })
        }
    }, [seedAssetUrl])

    // Deliberately does not flip `layersLoading` on: it starts true for the
    // first load, and a re-query (a filter change) swaps the rows in place
    // rather than flashing the list back to a spinner.
    const refreshLayers = useCallback(async (params = {}, signal) => {
        try {
            const response = await api.listLayers({ limit: LAYER_PAGE_SIZE, offset: 0, ...params }, signal)

            if (signal?.aborted) {
                return
            }

            const incoming = response?.layers ?? []
            const issuedAt = Date.now()

            for (const layer of incoming) {
                seedAssetUrl(layer.overlay_key, layer.overlay_url, layer.url_expires_in, issuedAt)
                seedAssetUrl(layer.geojson_key, layer.geojson_url, layer.url_expires_in, issuedAt)
            }

            setLayers(incoming.map((layer) => ({ ...layer, urlIssuedAt: issuedAt })))
            setLayersTotal(response?.total ?? incoming.length)
            setOpacityByLayer((current) => {
                const next = { ...current }

                for (const layer of incoming) {
                    if (!(layer.layer_id in next)) {
                        next[layer.layer_id] = DEFAULT_OPACITY
                    }
                }

                return next
            })
            setLayersError('')
        } catch (error) {
            if (error?.name !== 'AbortError') {
                setLayersError(error?.message || 'Unable to load layers.')
            }
        } finally {
            if (!signal?.aborted) {
                setLayersLoading(false)
            }
        }
    }, [api, seedAssetUrl])

    useEffect(() => {
        const controller = new AbortController()

        // Wrapped so the state updates land in an async continuation rather
        // than synchronously in the effect body.
        const load = async () => {
            await refreshLayers({}, controller.signal)
        }

        load()

        return () => controller.abort()
    }, [refreshLayers])

    // Resume tracking after a reload: anything still non-terminal server-side
    // goes back into the poll set.
    useEffect(() => {
        const controller = new AbortController()

        const loadPending = async () => {
            try {
                const response = await api.listJobs({ limit: 20, offset: 0 }, controller.signal)

                if (controller.signal.aborted) {
                    return
                }

                for (const job of response?.jobs ?? []) {
                    if (!isTerminal(job.status)) {
                        dispatch({ type: 'JOB_CREATED', job })
                    }
                }
            } catch {
                // A missing jobs list is not worth a banner; the layer list
                // error already covers "backend unreachable".
            }
        }

        loadPending()
        return () => controller.abort()
    }, [api])

    const deleteLayer = useCallback(async (layerId) => {
        await api.deleteLayer(layerId)

        setLayers((current) => current.filter((layer) => layer.layer_id !== layerId))
        setVisibleLayerIds((current) => current.filter((id) => id !== layerId))
        setSelectedLayerId((current) => (current === layerId ? null : current))
        setLayersTotal((current) => Math.max(0, current - 1))
    }, [api])

    /* — map state — */

    const requestFit = useCallback((apiBoundsList) => {
        const list = (Array.isArray(apiBoundsList?.[0]) ? apiBoundsList : [apiBoundsList]).filter(Boolean)

        if (list.length === 0) {
            return
        }

        fitNonce.current += 1
        setFitRequest({ bounds: list, nonce: fitNonce.current })
        setFitSuggestion(null)
    }, [])

    /**
     * Nothing is more annoying than a map that yanks itself, so once the user
     * has panned we offer a button instead of moving the view.
     */
    const suggestFit = useCallback((apiBoundsList, label) => {
        const list = (Array.isArray(apiBoundsList?.[0]) ? apiBoundsList : [apiBoundsList]).filter(Boolean)

        if (list.length === 0) {
            return
        }

        setFitSuggestion({ bounds: list, label })
    }, [])

    const acceptFitSuggestion = useCallback(() => {
        setFitSuggestion((suggestion) => {
            if (suggestion) {
                fitNonce.current += 1
                setFitRequest({ bounds: suggestion.bounds, nonce: fitNonce.current })
            }

            return null
        })
    }, [])

    const toggleLayerVisibility = useCallback((layerId, visible) => {
        setVisibleLayerIds((current) => {
            const isVisible = current.includes(layerId)
            const next = visible ?? !isVisible

            if (next === isVisible) {
                return current
            }

            return next ? [...current, layerId] : current.filter((id) => id !== layerId)
        })
    }, [])

    const setLayerOpacity = useCallback((layerId, opacity) => {
        setOpacityByLayer((current) => ({ ...current, [layerId]: opacity }))
    }, [])

    const firstFitDoneRef = useRef(false)

    // Fit to the first layer that becomes visible, but never afterwards and
    // never once the user has taken control of the view.
    useEffect(() => {
        if (firstFitDoneRef.current || userMoved || visibleLayerIds.length === 0) {
            return
        }

        const layer = layers.find((entry) => entry.layer_id === visibleLayerIds[0])

        if (layer?.bounds) {
            firstFitDoneRef.current = true
            requestFit([layer.bounds])
        }
    }, [visibleLayerIds, layers, userMoved, requestFit])

    /* — jobs — */

    const pendingIds = useMemo(
        () => jobs.filter((job) => !isTerminal(job.status)).map((job) => job.job_id).sort(),
        [jobs],
    )

    // The effect keys on this string, not on `jobs`, or it would tear down and
    // restart the whole chain on every poll response.
    const pendingKey = pendingIds.join(',')

    // Mirrored into refs after render, so the poll tick and onJobDone can read
    // current values without being re-created (which would restart the chain).
    const pendingIdsRef = useRef(pendingIds)
    const userMovedRef = useRef(userMoved)

    useEffect(() => {
        pendingIdsRef.current = pendingIds
        userMovedRef.current = userMoved
    }, [pendingIds, userMoved])

    const onJobDone = useCallback((job) => {
        if (ingestedJobsRef.current.has(job.job_id)) {
            return
        }

        ingestedJobsRef.current.add(job.job_id)
        jobFilesRef.current.delete(job.job_id)

        // §6 guarantees `layers` is fully hydrated with signed URLs when a job
        // reports done, so there is no second request to make here.
        const produced = job.layers ?? []

        if (produced.length === 0) {
            return
        }

        ingestLayers(produced, { autoShow: true })

        const bounds = produced.map((layer) => layer.bounds).filter(Boolean)

        if (bounds.length === 0) {
            return
        }

        if (userMovedRef.current) {
            suggestFit(bounds, produced.length > 1
                ? `Zoom to ${produced.length} new layers`
                : 'Zoom to new layer')
        } else {
            firstFitDoneRef.current = true
            requestFit(bounds)
        }
    }, [ingestLayers, requestFit, suggestFit])

    useEffect(() => {
        if (!pendingKey) {
            return undefined
        }

        const controller = new AbortController()
        const startedAt = Date.now()
        let timer = null
        let stopped = false

        const tick = async () => {
            if (stopped) {
                return
            }

            // Polling a backgrounded tab wastes the queue's attention and the
            // user's battery; the next visible tick catches up.
            if (document.visibilityState === 'visible') {
                await Promise.all(pendingIdsRef.current.map(async (jobId) => {
                    try {
                        const job = await api.getJob(jobId, controller.signal)

                        if (stopped) {
                            return
                        }

                        dispatch({ type: 'JOB_POLLED', job })

                        if (job.status === 'done') {
                            onJobDone(job)
                        }
                    } catch (error) {
                        if (error?.name === 'AbortError' || stopped) {
                            return
                        }

                        if (error?.status === 404) {
                            dispatch({ type: 'JOB_DISMISSED', jobId })
                            return
                        }

                        dispatch({ type: 'JOB_POLL_ERROR', jobId, error: error?.message || 'Lost contact with the job.' })
                    }
                }))
            }

            if (!stopped) {
                timer = setTimeout(tick, pollDelay(Date.now() - startedAt))
            }
        }

        timer = setTimeout(tick, FIRST_POLL_DELAY_MS)

        return () => {
            stopped = true
            clearTimeout(timer)
            controller.abort()
        }
    }, [pendingKey, api, onJobDone])

    /**
     * The whole create → upload → start pipeline lives here rather than in the
     * panel: a retry fired from the job rail must work even when the panel for
     * that type is unmounted, and JOB_PROGRESS has to reach the same reducer the
     * poll loop writes to.
     */
    const submitGisJob = useCallback(async ({ layerType, name, files, options }) => {
        const created = await api.createJob({
            layerType,
            name,
            files,
            options: serializeOptions(layerType, options),
        })

        const jobId = created.job_id

        jobFilesRef.current.set(jobId, files)
        ingestedJobsRef.current.delete(jobId)

        const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

        dispatch({
            type: 'JOB_CREATED',
            job: { ...created, options: created.options ?? options, layer_type: layerType, name },
            upload: { loadedBytes: 0, totalBytes },
        })

        setActiveJobId(jobId)

        const controller = new AbortController()
        uploadAbortRef.current.set(jobId, controller)

        try {
            await uploadGisFiles({
                files,
                uploadUrls: created.upload_urls,
                signal: controller.signal,
                onProgress: (upload) => dispatch({ type: 'JOB_PROGRESS', jobId, upload }),
            })

            const started = await api.startJob(jobId)

            dispatch({ type: 'JOB_POLLED', job: { job_id: jobId, ...started } })
            dispatch({ type: 'JOB_PROGRESS', jobId, upload: null })
        } catch (error) {
            if (error?.name === 'AbortError') {
                // abortJob already dispatched the dismissal.
                throw error
            }

            dispatch({ type: 'JOB_FAILED', jobId, error: error?.message || 'Upload failed.' })
            throw error
        } finally {
            uploadAbortRef.current.delete(jobId)
        }

        return created
    }, [api])

    /**
     * For a job left at `awaiting_upload` by a failed `/start`: the inputs are
     * already in storage, so this re-runs only the start call rather than
     * re-uploading hundreds of megabytes.
     */
    const startExistingJob = useCallback(async (jobId) => {
        const started = await api.startJob(jobId)
        dispatch({ type: 'JOB_POLLED', job: { job_id: jobId, ...started } })
    }, [api])

    const retryJob = useCallback(async (jobId, patch = {}) => {
        const job = jobs.find((entry) => entry.job_id === jobId)
        const files = jobFilesRef.current.get(jobId)

        if (!job || !files?.length) {
            throw new Error('The original files are no longer held — pick them again to retry.')
        }

        const options = { ...(job.options ?? {}), ...patch }

        // Drop the old card first, so the rail doesn't show two attempts at once.
        dispatch({ type: 'JOB_DISMISSED', jobId })
        jobFilesRef.current.delete(jobId)

        return submitGisJob({
            layerType: job.layer_type,
            name: job.name,
            files,
            options,
        })
    }, [jobs, submitGisJob])

    const abortJob = useCallback(async (jobId) => {
        const controller = uploadAbortRef.current.get(jobId)

        if (controller) {
            controller.abort()
            uploadAbortRef.current.delete(jobId)
        }

        try {
            await api.deleteJob(jobId)
        } finally {
            jobFilesRef.current.delete(jobId)
            dispatch({ type: 'JOB_DISMISSED', jobId })
            setActiveJobId((current) => (current === jobId ? null : current))
        }
    }, [api])

    const dismissJob = useCallback((jobId) => {
        jobFilesRef.current.delete(jobId)
        dispatch({ type: 'JOB_DISMISSED', jobId })
        setActiveJobId((current) => (current === jobId ? null : current))
    }, [])

    const hasRetainedFiles = useCallback((jobId) => Boolean(jobFilesRef.current.get(jobId)?.length), [])

    /**
     * The nonce is stamped here rather than at the call site so it comes from a
     * counter instead of a clock — the upload panel is keyed on it, and a key
     * must not depend on when a re-render happened to occur.
     */
    const requestJobPrefill = useCallback((prefill) => {
        prefillNonce.current += 1
        setJobPrefill({ ...prefill, nonce: prefillNonce.current })
    }, [])

    const activeJob = useMemo(
        () => jobs.find((job) => job.job_id === activeJobId) ?? null,
        [jobs, activeJobId],
    )

    const pendingCount = pendingIds.length
    const queueFull = pendingCount >= (config.max_queue ?? 3)

    const value = useMemo(() => ({
        api,
        apiBaseUrl,
        config,
        configFallback,

        jobs,
        activeJob,
        activeJobId,
        setActiveJobId,
        pendingCount,
        queueFull,
        submitGisJob,
        retryJob,
        startExistingJob,
        abortJob,
        dismissJob,
        hasRetainedFiles,

        layers,
        layersLoading,
        layersError,
        layersTotal,
        refreshLayers,
        ingestLayers,
        deleteLayer,

        selectedLayerId,
        setSelectedLayerId,
        visibleLayerIds,
        toggleLayerVisibility,
        opacityByLayer,
        setLayerOpacity,

        basemap,
        setBasemap,
        userMoved,
        setUserMoved,
        viewBbox,
        setViewBbox,
        fitRequest,
        requestFit,
        fitSuggestion,
        acceptFitSuggestion,

        featureFocus,
        setFeatureFocus,
        jobPrefill,
        setJobPrefill,
        requestJobPrefill,
        bboxPreview,
        setBboxPreview,

        getFreshAssetUrl,
        urlsByKey,
    }), [
        api, apiBaseUrl, config, configFallback,
        jobs, activeJob, activeJobId, pendingCount, queueFull,
        submitGisJob, retryJob, startExistingJob, abortJob, dismissJob, hasRetainedFiles,
        layers, layersLoading, layersError, layersTotal, refreshLayers, ingestLayers, deleteLayer,
        selectedLayerId, visibleLayerIds, toggleLayerVisibility, opacityByLayer, setLayerOpacity,
        basemap, userMoved, viewBbox, fitRequest, requestFit, fitSuggestion, acceptFitSuggestion,
        featureFocus, jobPrefill, requestJobPrefill, bboxPreview,
        getFreshAssetUrl, urlsByKey,
    ])

    return (
        <GisLibraryContext.Provider value={value}>
            {children}
        </GisLibraryContext.Provider>
    )
}
