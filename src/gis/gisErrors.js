/**
 * `error_kind` → human copy. `retry` describes a re-run of the same job: the
 * upload panel holds the File[] until the job reaches a terminal state, so a
 * retry needs no re-pick. `patch` is merged over the original options.
 */
const ERROR_COPY = {
    missing_input: {
        title: 'Upload never arrived',
        detail: 'The server could not find the uploaded file. The upload link may have expired before the job started.',
        retry: { label: 'Start over' },
    },
    too_large: {
        title: 'File over the size limit',
        detail: null, // server string carries the actual sizes
    },
    unsupported_extension: {
        title: 'Extension not accepted',
        detail: null,
    },
    unreadable: {
        title: 'File could not be read',
        detail: (job) => {
            const extension = job?.input_files?.[0]?.filename?.match(/\.[^.]+$/)?.[0]
            return `Corrupt, truncated, or not really a ${extension ?? 'file of that type'}. Try re-exporting it.`
        },
        retry: { label: 'Retry' },
    },
    no_crs: {
        title: 'No coordinate system',
        detail: 'This file carries no CRS, so it can\'t be placed on a map. Re-export with one, '
            + 'e.g. gdal_edit.py -a_srs EPSG:32635 file.tif',
    },
    no_ground_points: {
        title: 'No ground returns',
        detail: 'This tile has no class-2 points, so a DEM can\'t be built from it. A DSM grids the '
            + 'highest return instead and works on unclassified data.',
        retry: { label: 'Retry as DSM', patch: { kind: 'dsm' } },
    },
    raster_too_large: {
        title: 'Raster too large',
        detail: (job, config) => 'Over the '
            + `${(config?.max_raster_pixels ?? 16000000).toLocaleString()} pixel budget after reprojection. `
            + 'Downsample first: gdal_translate -outsize 50% 50% in.tif out.tif',
    },
    lidar_grid_too_large: {
        title: 'Grid too large',
        detail: null, // the server string includes the minimum viable cell size
        // Doubling the cell quarters the cell count, which clears the budget in
        // one step for anything that was merely a little over.
        retry: (job) => {
            const cell = Number(job?.options?.cell)

            if (!Number.isFinite(cell)) {
                return null
            }

            const next = Math.min(50, Number((cell * 2).toFixed(2)))
            return { label: `Retry at ${next} m`, patch: { cell: next } }
        },
    },
    empty_result: {
        title: 'Nothing to draw',
        detail: 'No features survived processing. If you set a bounding box, widen or clear it.',
        retry: { label: 'Retry without bounding box', patch: { bbox: null } },
    },
    oom: {
        title: 'Ran out of memory',
        detail: 'The worker ran out of memory on this file. A smaller area or a coarser cell size will fit.',
        retry: { label: 'Retry' },
    },
    disk_full: {
        title: 'Out of disk space',
        detail: 'The worker ran out of scratch space. Retrying once other jobs have finished usually clears it.',
        retry: { label: 'Retry' },
    },
    queue_timeout: {
        title: 'Timed out in the queue',
        detail: 'The job waited too long to start and was dropped.',
        retry: { label: 'Retry' },
    },
    worker_restart: {
        title: 'Worker restarted',
        detail: 'The worker restarted mid-job, so this run was lost. Nothing is wrong with the file.',
        retry: { label: 'Retry' },
    },
    internal: {
        title: 'Processing failed',
        detail: 'The server hit an unexpected error. The log below is the useful part.',
        retry: { label: 'Retry' },
    },
}

/**
 * Unknown or missing kind falls back to the raw job error, mirroring
 * Upload.jsx:232. The `log` is rendered under a <details> in every failure case
 * regardless of what this returns.
 */
export function describeJobError(job, config) {
    const entry = ERROR_COPY[job?.error_kind]

    if (!entry) {
        return {
            title: 'Processing failed',
            detail: job?.error || 'Processing failed.',
            retry: { label: 'Retry' },
        }
    }

    const detail = typeof entry.detail === 'function'
        ? entry.detail(job, config)
        : entry.detail

    const retry = typeof entry.retry === 'function' ? entry.retry(job) : entry.retry

    return {
        title: entry.title,
        // A null `detail` means the server string is more specific than anything
        // we could write, because it carries the actual numbers.
        detail: detail ?? job?.error ?? 'Processing failed.',
        retry: retry ?? null,
    }
}

export const STATUS_LABELS = {
    awaiting_upload: 'Awaiting upload',
    queued: 'Queued',
    running: 'Running',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
}

export const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled'])

export const isTerminal = (status) => TERMINAL_STATUSES.has(status)

/** The five `step` values, in the order the worker walks them. */
export const JOB_STEPS = [
    { id: 'downloading', label: 'Fetching input' },
    { id: 'preflight', label: 'Checking size and CRS' },
    { id: 'processing', label: 'Processing' },
    { id: 'uploading', label: 'Storing results' },
    { id: 'indexing', label: 'Indexing layers' },
]

export function stepIndex(step) {
    return JOB_STEPS.findIndex((entry) => entry.id === step)
}

/**
 * A cross-origin failure on the GeoJSON fetch surfaces as a TypeError with no
 * status, which reads as a frontend bug when it is a bucket configuration one.
 */
export const CORS_MESSAGE = 'The storage bucket is blocking this request (CORS). '
    + "Add the app origin to the R2 bucket's allowed GET origins."

export const EXPIRED_UPLOAD_MESSAGE = 'Upload link expired; start the job again.'

export function queueFullMessage(config) {
    const max = config?.max_queue ?? 3
    return `${max} jobs already pending — wait for one to finish.`
}
