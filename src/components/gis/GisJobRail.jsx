import { useEffect, useRef, useState } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { describeJobError, JOB_STEPS, STATUS_LABELS, stepIndex } from '../../gis/gisErrors.js'
import { formatBytes, formatDuration } from '../../gis/gisFormat.js'
import { getGisType } from '../../gis/gisConfig.js'

function UploadProgress({ upload }) {
    const { loadedBytes, totalBytes } = upload
    const percent = totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0

    return (
        <div className="gv-progress">
            <div className="gv-progress-label">
                Uploading {formatBytes(loadedBytes)} / {formatBytes(totalBytes)} ({percent}%)
            </div>
            <div className="gv-progress-bar">
                <span style={{ width: `${percent}%` }} />
            </div>
        </div>
    )
}

function JobSteps({ step, log }) {
    const current = stepIndex(step)
    const logRef = useRef(null)

    // Auto-scroll: the interesting line of processor stdout is always the last
    // one.
    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight
        }
    }, [log])

    return (
        <div className="gv-job-steps">
            {JOB_STEPS.map((entry, index) => {
                const state = current < 0 || index > current
                    ? 'pending'
                    : index === current ? 'active' : 'done'

                return (
                    <div className="gv-step" data-state={state} key={entry.id}>
                        <span className="gv-step-dot" />
                        <span className="gv-step-label">{entry.label}</span>

                        {/* processing is the long one, and the backend captures
                            processor stdout precisely so it can be shown here. */}
                        {entry.id === 'processing' && state === 'active' && log ? (
                            <pre className="gv-job-log" ref={logRef}>{log}</pre>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}

function ErrorCard({ job, config, onRetry, retryable, retrying }) {
    const { title, detail, retry } = describeJobError(job, config)

    return (
        <div className="gv-error-card">
            <div className="gv-error-card-title">{title}</div>
            <p className="gv-error-card-detail">{detail}</p>

            {retry && retryable ? (
                <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={retrying}
                    onClick={() => onRetry(retry.patch ?? {})}
                >
                    {retrying ? 'Retrying…' : retry.label}
                </button>
            ) : null}

            {retry && !retryable ? (
                <p className="text-muted gv-gis-limits">
                    Pick the file again to retry — the original selection is no longer held.
                </p>
            ) : null}

            {/* The raw log stays available in every failure case: it is the most
                useful debugging artefact and it costs nothing. */}
            {job.log ? (
                <details className="gv-job-details">
                    <summary>Processing log</summary>
                    <pre className="gv-job-log">{job.log}</pre>
                </details>
            ) : null}
        </div>
    )
}

export default function GisJobRail() {
    const {
        activeJob: job,
        config,
        abortJob,
        dismissJob,
        retryJob,
        startExistingJob,
        hasRetainedFiles,
        jobs,
        setActiveJobId,
    } = useGisLibrary()

    const [busy, setBusy] = useState('')
    const [actionError, setActionError] = useState('')

    if (!job) {
        return null
    }

    const type = getGisType(job.layer_type)
    const retryable = hasRetainedFiles(job.job_id)

    // Only for finished jobs: deriving a live elapsed time would mean calling
    // Date.now() during render, which is not a pure render input.
    const elapsed = job.started_at && job.finished_at
        ? Date.parse(job.finished_at) - Date.parse(job.started_at)
        : null

    const run = (label, fn) => async () => {
        setBusy(label)
        setActionError('')

        try {
            await fn()
        } catch (error) {
            if (error?.name !== 'AbortError') {
                setActionError(error?.message || 'That action failed.')
            }
        } finally {
            setBusy('')
        }
    }

    // The backend 409s on a running job, because BackgroundTasks are not
    // interruptible — so don't offer the button rather than surfacing a 409.
    const cancellable = job.status === 'awaiting_upload' || job.status === 'queued'
    const otherJobs = jobs.filter((entry) => entry.job_id !== job.job_id)

    return (
        <>
            <div className="gv-detail-head">
                <span className="text-muted gv-detail-kicker">Job</span>
                <span className="tag tag-accent">{type.label}</span>
            </div>

            <div className="gv-detail-name">{job.name || job.job_id}</div>

            <div className="gv-detail-rows">
                <div className="gv-detail-row">
                    <span className="gv-detail-label">Status</span>
                    <span className="gv-detail-value">{STATUS_LABELS[job.status] ?? job.status}</span>
                </div>
                {job.queue_position != null && job.status === 'queued' ? (
                    <div className="gv-detail-row">
                        <span className="gv-detail-label">Queue</span>
                        <span className="gv-detail-value">position {job.queue_position}</span>
                    </div>
                ) : null}
                {job.input_files?.length ? (
                    <div className="gv-detail-row">
                        <span className="gv-detail-label">Files</span>
                        <span className="gv-detail-value">{job.input_files.length}</span>
                    </div>
                ) : null}
                {elapsed != null ? (
                    <div className="gv-detail-row">
                        <span className="gv-detail-label">Took</span>
                        <span className="gv-detail-value">{formatDuration(elapsed)}</span>
                    </div>
                ) : null}
            </div>

            {job.upload ? <UploadProgress upload={job.upload} /> : null}

            {job.status === 'queued' ? (
                <div className="gv-job-status">
                    <span className="gv-pulse-dot" />
                    Waiting for the worker
                </div>
            ) : null}

            {job.status === 'running' ? <JobSteps step={job.step} log={job.log} /> : null}

            {job.status === 'done' ? (
                <div className="gv-job-status">
                    Added {job.layers?.length ?? 0} layer{(job.layers?.length ?? 0) === 1 ? '' : 's'} to the map.
                </div>
            ) : null}

            {/* Only reachable after a failed /start, which leaves the job
                sitting on its uploaded input. */}
            {job.status === 'awaiting_upload' && !job.upload ? (
                <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={busy !== ''}
                    onClick={run('start', () => startExistingJob(job.job_id))}
                >
                    {busy === 'start' ? 'Starting…' : 'Retry start'}
                </button>
            ) : null}

            {job.status === 'failed' ? (
                <ErrorCard
                    job={job}
                    config={config}
                    retryable={retryable}
                    retrying={busy === 'retry'}
                    onRetry={(patch) => run('retry', () => retryJob(job.job_id, patch))()}
                />
            ) : null}

            {job.localError ? <p className="gv-library-error">{job.localError}</p> : null}
            {job.pollError ? <p className="text-muted gv-gis-limits">{job.pollError}</p> : null}
            {actionError ? <p className="gv-library-error">{actionError}</p> : null}

            {cancellable ? (
                <button
                    type="button"
                    className="btn btn-secondary btn-block"
                    disabled={busy !== ''}
                    onClick={run('cancel', () => abortJob(job.job_id))}
                >
                    {busy === 'cancel' ? 'Cancelling…' : 'Cancel job'}
                </button>
            ) : null}

            {job.status === 'running' ? (
                <p className="text-muted gv-gis-limits">
                    A running job can&apos;t be cancelled — it will finish or fail on its own.
                </p>
            ) : null}

            {(job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') ? (
                <button
                    type="button"
                    className="btn btn-secondary btn-block"
                    onClick={() => dismissJob(job.job_id)}
                >
                    Dismiss
                </button>
            ) : null}

            {otherJobs.length > 0 ? (
                <div className="gv-job-others">
                    <span className="gv-detail-label">Other jobs</span>
                    {otherJobs.map((entry) => (
                        <button
                            type="button"
                            className="gv-job-other"
                            key={entry.job_id}
                            onClick={() => setActiveJobId(entry.job_id)}
                        >
                            <span className="gv-job-other-name">{entry.name || entry.job_id}</span>
                            <span className="tag tag-outline">{STATUS_LABELS[entry.status] ?? entry.status}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </>
    )
}
