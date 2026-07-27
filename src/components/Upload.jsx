import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { IconArrowRight, IconClose, IconNode, IconRegion, IconSearch, IconUpload } from './icons.jsx'

const POLL_INTERVAL_MS = 3000

const formatBytes = (bytes) => {
    if (bytes < 1024) {
        return `${bytes} B`
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isImage = (file) => file.type.startsWith('image/')

function TargetRow({ item, active, onSelect }) {
    const Icon = item.type === 'node' ? IconNode : IconRegion

    return (
        <button type="button" className="gv-row" data-active={active ? '1' : '0'} onClick={onSelect}>
            <span className="gv-row-icon">
                <Icon />
            </span>
            <span className="gv-row-text">
                <span className="gv-row-name">{item.name}</span>
                <span className="gv-row-coords text-muted">{item.id}</span>
            </span>
            {item.hasModel ? <span className="tag tag-outline">has splat</span> : null}
        </button>
    )
}

function Upload() {
    const { apiBaseUrl } = useSplatLibrary()

    const [mode, setMode] = useState('existing') // 'existing' | 'new'
    const [targetType, setTargetType] = useState('node') // 'node' | 'region'

    const [targets, setTargets] = useState({ nodes: [], regions: [] })
    const [targetsError, setTargetsError] = useState('')
    const [targetsLoading, setTargetsLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState(null)

    const [newName, setNewName] = useState('')
    const [newLat, setNewLat] = useState('')
    const [newLon, setNewLon] = useState('')

    const [files, setFiles] = useState([])
    const [dragging, setDragging] = useState(false)
    const fileInputRef = useRef(null)

    const [running, setRunning] = useState(false)
    const [status, setStatus] = useState('')
    const [error, setError] = useState('')
    const [result, setResult] = useState(null) // { modelPath, name }

    useEffect(() => {
        document.title = 'Upload'
    }, [])

    // All nodes/regions, not just processed ones — /splat_nodes and /splat_regions
    // only return features that already have a model_path.
    useEffect(() => {
        let active = true

        const loadTargets = async () => {
            try {
                const [nodesResponse, regionsResponse] = await Promise.all([
                    fetch(`${apiBaseUrl}/nodes`),
                    fetch(`${apiBaseUrl}/regions`),
                ])

                if (!nodesResponse.ok || !regionsResponse.ok) {
                    throw new Error('Unable to load nodes and regions from the backend.')
                }

                const [nodesData, regionsData] = await Promise.all([
                    nodesResponse.json(),
                    regionsResponse.json(),
                ])

                if (!active) {
                    return
                }

                setTargets({ nodes: nodesData, regions: regionsData })
                setTargetsError('')
            } catch (loadError) {
                if (!active) {
                    return
                }

                setTargetsError(loadError instanceof Error ? loadError.message : 'Unable to load targets.')
            } finally {
                if (active) {
                    setTargetsLoading(false)
                }
            }
        }

        loadTargets()

        return () => {
            active = false
        }
    }, [apiBaseUrl])

    const items = useMemo(() => {
        if (targetType === 'node') {
            return targets.nodes.map((node) => ({
                type: 'node',
                id: String(node.node_id),
                name: node.tags?.name ?? `Node ${node.node_id}`,
                hasModel: Boolean(node.model_path),
            }))
        }

        return targets.regions.map((region) => ({
            type: 'region',
            id: String(region.id),
            name: region.name,
            hasModel: Boolean(region.model_path),
        }))
    }, [targetType, targets])

    const query = search.trim().toLowerCase()
    const filteredItems = items.filter(
        (item) => !query || item.name.toLowerCase().includes(query) || item.id.includes(query),
    )

    const addFiles = (incoming) => {
        const images = Array.from(incoming).filter(isImage)

        setFiles((current) => {
            const seen = new Set(current.map((file) => `${file.name}:${file.size}`))
            return [...current, ...images.filter((file) => !seen.has(`${file.name}:${file.size}`))]
        })
    }

    const handleDrop = (event) => {
        event.preventDefault()
        setDragging(false)
        addFiles(event.dataTransfer.files)
    }

    const removeFile = (index) => {
        setFiles((current) => current.filter((_, i) => i !== index))
    }

    const targetReady = mode === 'existing'
        ? Boolean(selectedId)
        : Boolean(newName.trim()) && (targetType === 'region' || (newLat !== '' && newLon !== ''))

    const canProcess = targetReady && files.length > 0 && !running

    const reset = () => {
        setRunning(false)
        setStatus('')
        setError('')
        setResult(null)
    }

    const pollUntilDone = async (jobId) => {
        // Resolves once the backend reports a terminal state.
        while (true) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

            const response = await fetch(`${apiBaseUrl}/jobs/${jobId}`)

            if (!response.ok) {
                throw new Error(`Unable to check job status (${response.status})`)
            }

            const job = await response.json()

            if (job.status === 'done') {
                return job
            }

            if (job.status === 'failed') {
                throw new Error(job.error || 'Processing failed.')
            }
        }
    }

    const handleProcess = async () => {
        setRunning(true)
        setError('')
        setResult(null)

        try {
            let type = targetType
            let id = selectedId
            let name = items.find((item) => item.id === selectedId)?.name ?? ''

            if (mode === 'new') {
                setStatus(`Creating ${targetType}…`)
                name = newName.trim()

                const body = targetType === 'node'
                    ? { name, lat: Number(newLat), lon: Number(newLon) }
                    : { name }

                const createResponse = await fetch(`${apiBaseUrl}/${targetType}s`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })

                if (!createResponse.ok) {
                    throw new Error(`Unable to create ${targetType} (${createResponse.status})`)
                }

                const created = await createResponse.json()
                id = String(targetType === 'node' ? created.node_id : created.id)
                type = targetType
            }

            setStatus('Creating job…')

            const jobResponse = await fetch(`${apiBaseUrl}/jobs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    target_type: type,
                    target_id: id,
                    filenames: files.map((file) => file.name),
                }),
            })

            if (!jobResponse.ok) {
                throw new Error(`Unable to create job (${jobResponse.status})`)
            }

            const { job_id: jobId, upload_urls: uploadUrls } = await jobResponse.json()

            setStatus(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`)

            await Promise.all(files.map(async (file) => {
                const uploadUrl = uploadUrls?.[file.name]

                if (!uploadUrl) {
                    throw new Error(`No upload URL was issued for ${file.name}`)
                }

                const uploadResponse = await fetch(uploadUrl, {
                    method: 'PUT',
                    body: file,
                    headers: { 'Content-Type': file.type },
                })

                if (!uploadResponse.ok) {
                    throw new Error(`Upload failed for ${file.name} (${uploadResponse.status})`)
                }
            }))

            setStatus('Starting job…')

            const startResponse = await fetch(`${apiBaseUrl}/jobs/${jobId}/start`, { method: 'POST' })

            if (!startResponse.ok) {
                throw new Error(`Unable to start job (${startResponse.status})`)
            }

            setStatus('Processing (this can take a while)…')

            const job = await pollUntilDone(jobId)

            setStatus('Done')
            setResult({ modelPath: job.output_key, name: name || job.target_id })
        } catch (processError) {
            setError(processError instanceof Error ? processError.message : 'Processing failed.')
            setStatus('')
        } finally {
            setRunning(false)
        }
    }

    return (
        <div className="gv-library">
            <div className="gv-library-head">
                <div>
                    <div className="card-kicker">Upload</div>
                    <h2 className="gv-library-title">Create a splat from photos</h2>
                    <p className="text-muted gv-library-subtitle">
                        Pick a target, add a set of photos, then process them into a Gaussian splat.
                    </p>
                </div>
            </div>

            <div className="gv-library-grid">
                <div className="gv-library-lists">
                    <section>
                        <div className="gv-section-head">
                            <h4>Target</h4>
                            <div className="hr gv-section-rule" />
                        </div>

                        <div className="gv-toggle-group">
                            <button
                                type="button"
                                className={`btn ${mode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => setMode('existing')}
                            >
                                Existing
                            </button>
                            <button
                                type="button"
                                className={`btn ${mode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => setMode('new')}
                            >
                                Create new
                            </button>
                            <div className="gv-toggle-spacer" />
                            <button
                                type="button"
                                className={`btn ${targetType === 'node' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => { setTargetType('node'); setSelectedId(null) }}
                            >
                                Node
                            </button>
                            <button
                                type="button"
                                className={`btn ${targetType === 'region' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => { setTargetType('region'); setSelectedId(null) }}
                            >
                                Region
                            </button>
                        </div>

                        {mode === 'existing' ? (
                            <>
                                <div className="field gv-search-field">
                                    <div className="gv-search-wrap">
                                        <span className="gv-search-icon">
                                            <IconSearch />
                                        </span>
                                        <input
                                            className="input gv-search-input"
                                            placeholder={`Search ${targetType}s`}
                                            value={search}
                                            onChange={(event) => setSearch(event.target.value)}
                                        />
                                    </div>
                                </div>

                                {targetsError ? <p className="gv-library-error">{targetsError}</p> : null}

                                <div className="gv-section-rows gv-target-list">
                                    {filteredItems.length > 0 ? (
                                        filteredItems.map((item) => (
                                            <TargetRow
                                                key={item.id}
                                                item={item}
                                                active={selectedId === item.id}
                                                onSelect={() => setSelectedId(item.id)}
                                            />
                                        ))
                                    ) : (
                                        <p className="text-muted gv-empty-row">
                                            {targetsLoading ? `Loading ${targetType}s…` : `No ${targetType}s found.`}
                                        </p>
                                    )}
                                </div>
                            </>
                        ) : (
                            <div className="gv-new-target">
                                <div className="field">
                                    <label className="gv-detail-label" htmlFor="new-name">Name</label>
                                    <input
                                        id="new-name"
                                        className="input"
                                        placeholder={`New ${targetType} name`}
                                        value={newName}
                                        onChange={(event) => setNewName(event.target.value)}
                                    />
                                </div>

                                {targetType === 'node' ? (
                                    <div className="gv-coord-fields">
                                        <div className="field">
                                            <label className="gv-detail-label" htmlFor="new-lat">Latitude</label>
                                            <input
                                                id="new-lat"
                                                className="input"
                                                type="number"
                                                step="any"
                                                placeholder="45.75372"
                                                value={newLat}
                                                onChange={(event) => setNewLat(event.target.value)}
                                            />
                                        </div>
                                        <div className="field">
                                            <label className="gv-detail-label" htmlFor="new-lon">Longitude</label>
                                            <input
                                                id="new-lon"
                                                className="input"
                                                type="number"
                                                step="any"
                                                placeholder="21.22571"
                                                value={newLon}
                                                onChange={(event) => setNewLon(event.target.value)}
                                            />
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </section>

                    <section>
                        <div className="gv-section-head">
                            <h4>Photos</h4>
                            <span className="tag tag-neutral">{files.length}</span>
                            <div className="hr gv-section-rule" />
                        </div>

                        <div
                            className="gv-dropzone"
                            data-dragging={dragging ? '1' : '0'}
                            onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <IconUpload />
                            <span className="gv-dropzone-text">Drop photos here or click to browse</span>
                            <span className="text-muted gv-dropzone-hint">Images only · a full set of one scene</span>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
                            />
                        </div>

                        {files.length > 0 ? (
                            <div className="gv-file-list">
                                {files.map((file, index) => (
                                    <div className="gv-file-row" key={`${file.name}:${file.size}`}>
                                        <span className="gv-file-name">{file.name}</span>
                                        <span className="text-muted gv-file-size">{formatBytes(file.size)}</span>
                                        <button
                                            type="button"
                                            className="gv-tool gv-tool--sm"
                                            onClick={() => removeFile(index)}
                                            aria-label={`Remove ${file.name}`}
                                        >
                                            <IconClose />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </section>
                </div>

                <aside className="gv-detail-rail">
                    <div className="gv-detail-head">
                        <span className="text-muted gv-detail-kicker">Job</span>
                        <span className="tag tag-accent">{targetType}</span>
                    </div>

                    <div className="gv-detail-rows">
                        <div className="gv-detail-row">
                            <span className="gv-detail-label">Mode</span>
                            <span className="gv-detail-value">{mode === 'existing' ? 'Existing' : 'Create new'}</span>
                        </div>
                        <div className="gv-detail-row">
                            <span className="gv-detail-label">Target</span>
                            <span className="gv-detail-value gv-detail-value--right">
                                {mode === 'existing'
                                    ? (items.find((item) => item.id === selectedId)?.name ?? 'None selected')
                                    : (newName.trim() || 'Unnamed')}
                            </span>
                        </div>
                        <div className="gv-detail-row">
                            <span className="gv-detail-label">Photos</span>
                            <span className="gv-detail-value">{files.length}</span>
                        </div>
                    </div>

                    {status ? (
                        <div className="gv-job-status">
                            <span className="gv-pulse-dot" />
                            {status}
                        </div>
                    ) : null}

                    {error ? <p className="gv-library-error">{error}</p> : null}

                    {result ? (
                        <Link
                            className="btn btn-primary btn-block"
                            to="/viewer"
                            state={{ modelPath: result.modelPath, name: result.name }}
                        >
                            <IconArrowRight />
                            Open in visualizer
                        </Link>
                    ) : (
                        <button
                            type="button"
                            className="btn btn-primary btn-block"
                            disabled={!canProcess}
                            onClick={handleProcess}
                        >
                            <IconUpload />
                            {running ? 'Processing…' : 'Process'}
                        </button>
                    )}

                    {(result || error) && !running ? (
                        <button type="button" className="btn btn-secondary btn-block" onClick={reset}>
                            Start another
                        </button>
                    ) : null}
                </aside>
            </div>
        </div>
    )
}

export default Upload
