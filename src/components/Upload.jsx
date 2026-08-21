import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { useAuth } from '../hooks/useAuth.js'
import SignInNotice from './auth/SignInNotice.jsx'
import PolygonPicker from './PolygonPicker.jsx'
import { convexHull, MAX_POLYGON_VERTICES, meanPoint } from '../gis/gisGeo.js'
import { fileKey, readGpsPoints } from '../gis/photoGps.js'
import { IconArrowRight, IconClose, IconNode, IconArea, IconSearch, IconUpload } from './icons.jsx'
import { getNodeName, isAreaNode } from '../utils.jsx'

const POLL_INTERVAL_MS = 3000

// Uploading every file at once (one PUT per file, all in parallel) overwhelms
// the browser's connection pool/upload bandwidth once there are dozens of
// photos, and R2 resets the stalled connections instead of erroring cleanly.
// Cap how many PUTs are in flight at a time and work through the rest as a
// queue.
const UPLOAD_CONCURRENCY = 6
const UPLOAD_RETRIES = 3
const RETRY_BASE_DELAY_MS = 500

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A reset connection makes fetch reject outright rather than return a non-ok
// response, so a single stalled PUT would otherwise sink the whole batch.
async function uploadOne(file, uploadUrl) {
    let lastError

    for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
        if (attempt > 0) {
            await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
        }

        let uploadResponse

        try {
            uploadResponse = await fetch(uploadUrl, {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': file.type },
            })
        } catch (networkError) {
            lastError = networkError
            continue
        }

        if (uploadResponse.ok) {
            return
        }

        lastError = new Error(`Upload failed for ${file.name} (${uploadResponse.status})`)

        // A rejected signature or an expired URL will not fix itself.
        if (uploadResponse.status !== 429 && uploadResponse.status < 500) {
            throw lastError
        }
    }

    throw lastError
}

async function uploadFilesInBatches(files, uploadUrls, onProgress) {
    // Fail before spending bandwidth rather than on the last file of the set.
    const withoutUrl = files.find((file) => !uploadUrls?.[file.name])

    if (withoutUrl) {
        throw new Error(`No upload URL was issued for ${withoutUrl.name}`)
    }

    let nextIndex = 0
    let settled = 0
    const uploaded = []
    const skipped = []

    // Workers pull from one shared queue. Claiming an index and advancing it is a
    // single synchronous step, so no two workers can take the same file.
    const worker = async () => {
        while (nextIndex < files.length) {
            const file = files[nextIndex]
            nextIndex += 1

            try {
                await uploadOne(file, uploadUrls[file.name])
                uploaded.push(file.name)
            } catch (uploadError) {
                // One bad photo should not cost the user the whole set: leave it
                // out and let the reconstruction run on what did make it up.
                skipped.push({
                    name: file.name,
                    reason: uploadError instanceof Error ? uploadError.message : String(uploadError),
                })
            }

            settled += 1
            onProgress?.(settled, files.length)
        }
    }

    const workerCount = Math.min(UPLOAD_CONCURRENCY, files.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    // Nothing landed in R2, so there is no point starting a GPU job for it.
    if (uploaded.length === 0) {
        throw new Error(`All ${files.length} photos failed to upload. ${skipped[0]?.reason ?? ''}`.trim())
    }

    return { uploaded, skipped }
}

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
    const Icon = item.type === 'point' ? IconNode : IconArea

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
    const { isAuthed, getToken, handleUnauthorized } = useAuth()

    const [mode, setMode] = useState('existing') // 'existing' | 'new'
    const [targetShape, setTargetShape] = useState('point') // 'point' | 'area'

    const [targets, setTargets] = useState([])
    const [targetsError, setTargetsError] = useState('')
    const [targetsLoading, setTargetsLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState(null)

    const [newName, setNewName] = useState('')
    // The hand-drawn outline, [[lon, lat], ...] in API order. Kept separately
    // from the photo-derived shapes so switching sources never destroys it.
    const [drawnPolygon, setDrawnPolygon] = useState([])

    // The source the user picked by hand, or null while they have not — in
    // which case the photos decide. Only ever the *asked for* source; what is
    // actually in force is derived below, since a photo-derived source stops
    // existing the moment its photos do.
    const [chosenSource, setChosenSource] = useState(null) // 'photos' | 'point' | 'draw' | null

    // { 'name:size': [lon, lat] | null } — null means "scanned, has no GPS",
    // absent means "not scanned yet". Files are never re-read.
    const [gpsByFile, setGpsByFile] = useState({})
    const [gpsScanning, setGpsScanning] = useState(false)

    const [files, setFiles] = useState([])
    const [dragging, setDragging] = useState(false)
    const fileInputRef = useRef(null)
    // Files whose GPS is being read right now, so a re-render mid-scan does not
    // queue them a second time.
    const scanningKeys = useRef(new Set())
    const mounted = useRef(true)

    // Off by default, matching the backend's `want_mesh` default: the mesh is a
    // second GPU stage on top of the splat, so asking for it roughly doubles the
    // wait. Most uploads only ever get viewed as a splat.
    const [wantMesh, setWantMesh] = useState(false)

    const [running, setRunning] = useState(false)
    const [status, setStatus] = useState('')
    const [notice, setNotice] = useState('')
    const [error, setError] = useState('')
    const [result, setResult] = useState(null) // { modelPath, name }

    useEffect(() => {
        document.title = 'Upload'
    }, [])

    useEffect(() => () => {
        mounted.current = false
    }, [])

    // All nodes, not just processed ones /splat_nodes only returns features
    // that already have a model_path.
    useEffect(() => {
        let active = true

        const loadTargets = async () => {
            try {
                const nodesResponse = await fetch(`${apiBaseUrl}/nodes`)

                if (!nodesResponse.ok) {
                    throw new Error('Unable to load nodes from the backend.')
                }

                const nodesData = await nodesResponse.json()

                if (!active) {
                    return
                }

                setTargets(nodesData)
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

    // One list, split by geometry: the picker still offers two collections, but
    // they are two shapes of node rather than two tables.
    const items = useMemo(
        () => targets
            .filter((node) => (targetShape === 'area') === isAreaNode(node))
            .map((node) => ({
                type: targetShape,
                id: String(node.node_id),
                name: getNodeName(node),
                hasModel: Boolean(node.model_path),
            })),
        [targetShape, targets],
    )

    const query = search.trim().toLowerCase()
    const filteredItems = items.filter(
        (item) => !query || item.name.toLowerCase().includes(query) || item.id.includes(query),
    )

    const addFiles = (incoming) => {
        const images = Array.from(incoming).filter(isImage)

        setFiles((current) => {
            const seen = new Set(current.map(fileKey))
            return [...current, ...images.filter((file) => !seen.has(fileKey(file)))]
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

    // Read GPS out of any photo not seen yet.
    //
    // Deliberately not cancelled when `files` changes: a scan of 300 photos
    // easily outlives a second drop, and its results are keyed and additive, so
    // throwing them away to start over would be pure waste. The in-flight keys
    // are tracked instead, which is what stops the same file being read twice.
    useEffect(() => {
        const pending = files.filter((file) => {
            const key = fileKey(file)
            return !(key in gpsByFile) && !scanningKeys.current.has(key)
        })

        if (pending.length === 0) {
            return
        }

        for (const file of pending) {
            scanningKeys.current.add(fileKey(file))
        }

        setGpsScanning(true)

        readGpsPoints(pending)
            .then((found) => {
                if (mounted.current) {
                    setGpsByFile((current) => ({ ...current, ...found }))
                }
            })
            .finally(() => {
                for (const file of pending) {
                    scanningKeys.current.delete(fileKey(file))
                }

                if (mounted.current && scanningKeys.current.size === 0) {
                    setGpsScanning(false)
                }
            })
    }, [files, gpsByFile])

    // Derived from the *current* file list rather than a snapshot, so removing
    // a photo whose GPS fix is obviously wrong reshapes the outline on the spot.
    const photoPoints = useMemo(
        () => files.map((file) => gpsByFile[fileKey(file)]).filter(Boolean),
        [files, gpsByFile],
    )
    const photoHull = useMemo(() => convexHull(photoPoints), [photoPoints])
    const photoMean = useMemo(() => meanPoint(photoPoints), [photoPoints])

    const geotagged = photoPoints.length
    const hasHull = photoHull.length >= 3
    const hasMean = Boolean(photoMean)

    /**
     * The source actually in force.
     *
     * Derived rather than stored, so there is nothing to keep in sync: a
     * photo-derived source that runs out of photos falls back to drawing on
     * its own, and comes back if the photos do.
     *
     * Drawing is the floor — it needs nothing from the photos and always works.
     * With no choice made yet, the photo outline wins the moment it exists,
     * which is the whole point of reading the metadata; a drawing already under
     * way is left alone, because auto-selecting over it would discard work.
     */
    const outlineSource = useMemo(() => {
        if (chosenSource === 'photos') return hasHull ? 'photos' : 'draw'
        if (chosenSource === 'point') return hasMean ? 'point' : 'draw'
        if (chosenSource === 'draw') return 'draw'
        return hasHull && drawnPolygon.length === 0 ? 'photos' : 'draw'
    }, [chosenSource, hasHull, hasMean, drawnPolygon.length])

    const chooseSource = (next) => {
        setChosenSource(next)

        // Picking a mean point means the target is a point-shaped node; there
        // is no square to fake around it.
        if (next === 'point') {
            setTargetShape('point')
            setSelectedId(null)
        }
    }

    const activeRing = outlineSource === 'draw'
        ? drawnPolygon
        : outlineSource === 'photos' ? photoHull : []
    const activePoint = outlineSource === 'point' ? photoMean : null

    const removeAllFiles = () => {
        setFiles([])
    }

    const targetReady = mode === 'existing'
        ? Boolean(selectedId)
        // Both shapes need a geometry.
        : Boolean(newName.trim()) && (activeRing.length >= 3 || Boolean(activePoint))

    // The client gate is UX, not security the three POSTs below are still
    // rejected by the backend without a token.
    const canProcess = targetReady && files.length > 0 && !running && isAuthed

    const reset = () => {
        setRunning(false)
        setStatus('')
        setNotice('')
        setError('')
        setResult(null)
    }

    const pollUntilDone = async (jobId) => {
        // Resolves once the backend reports a terminal state.
        while (true) {
            await sleep(POLL_INTERVAL_MS)

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
        setNotice('')
        setError('')
        setResult(null)

        // Built once so the three write calls below stay identical. Deliberately
        // not applied to the presigned R2 PUTs in uploadOne(): an Authorization
        // header there breaks the S3 signature and the upload 403s.
        const token = getToken()
        const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

        // A token that expired mid-session should open the login popup rather
        // than surface as a raw error string.
        // Async so it can read `detail`. The server sends actionable validation
        // messages ("that outline is not a usable area"); without this they are
        // all replaced by a bare "Unable to create node (400)".
        const checkWrite = async (response, message) => {
            if (response.status === 401) {
                handleUnauthorized()
                throw new Error('Your session expired. Sign in again to continue.')
            }

            if (!response.ok) {
                const body = await response.json().catch(() => null)
                throw new Error(body?.detail || message)
            }
        }

        try {
            let id = selectedId
            let name = items.find((item) => item.id === selectedId)?.name ?? ''

            if (mode === 'new') {
                setStatus(`Creating ${targetShape}`)
                name = newName.trim()

                // The hull of a large enough photo set could in principle pass
                // the server's limit. Say so here rather than let it come back
                // as a 400 after the outline has already been accepted on screen.
                if (!activePoint && activeRing.length > MAX_POLYGON_VERTICES) {
                    throw new Error(
                        `That outline has ${activeRing.length} corners; the limit is`
                        + ` ${MAX_POLYGON_VERTICES}. Draw one by hand instead.`,
                    )
                }

                // One endpoint for both shapes: the server closes the ring,
                // stores the polygon as the node's own geometry, and tags it
                // source='drawn'. A mean point goes down the same endpoint's
                // lat/lon path instead.
                const body = activePoint
                    ? { name, lat: activePoint[1], lon: activePoint[0] }
                    : { name, polygon: activeRing }

                const createResponse = await fetch(`${apiBaseUrl}/nodes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body: JSON.stringify(body),
                })

                await checkWrite(createResponse, `Unable to create ${targetShape} (${createResponse.status})`)

                const created = await createResponse.json()
                id = String(created.node_id)
            }

            setStatus('Creating job…')

            const jobResponse = await fetch(`${apiBaseUrl}/jobs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    node_id: Number(id),
                    filenames: files.map((file) => file.name),
                    want_mesh: wantMesh,
                }),
            })

            await checkWrite(jobResponse, `Unable to create job (${jobResponse.status})`)

            const { job_id: jobId, upload_urls: uploadUrls } = await jobResponse.json()

            setStatus(`Uploading photo 0/${files.length}`)

            const { skipped } = await uploadFilesInBatches(files, uploadUrls, (done, total) => {
                setStatus(`Uploading photo ${done}/${total}`)
            })

            if (skipped.length > 0) {
                setNotice(
                    `${skipped.length} of ${files.length} photos could not be uploaded and were skipped: `
                    + skipped.map((item) => item.name).join(', '),
                )
            }

            setStatus('Starting job')

            const startResponse = await fetch(`${apiBaseUrl}/jobs/${jobId}/start`, {
                method: 'POST',
                headers: authHeaders,
            })

            await checkWrite(startResponse, `Unable to start job (${startResponse.status})`)

            setStatus(wantMesh
                ? 'Processing the splat (this can take a while)'
                : 'Processing (this can take a while)')

            const job = await pollUntilDone(jobId)

            setStatus('Done')
            setResult({ modelPath: job.output_key, name: name || String(job.node_id) })

            // `status` is about the splat alone, so a mesh job is still running
            // at this point. Say so rather than let the user conclude the mesh
            // was quietly dropped. Appended: a skipped-photos notice matters too.
            if (job.mesh_status === 'processing') {
                setNotice((current) => [
                    current,
                    'The splat is ready. The mesh is still building and will attach to this'
                    + ' target on its own you can leave this page.',
                ].filter(Boolean).join(' '))
            }
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
                                className={`btn ${targetShape === 'point' ? 'btn-primary' : 'btn-secondary'}`}
                                onClick={() => { setTargetShape('point'); setSelectedId(null); setDrawnPolygon([]) }}
                            >
                                Point
                            </button>
                            <button
                                type="button"
                                className={`btn ${targetShape === 'area' ? 'btn-primary' : 'btn-secondary'}`}
                                // A mean point can only be stored as a
                                // point-shaped node, so the shape is not the
                                // user's to change while that source is active.
                                disabled={mode === 'new' && outlineSource === 'point'}
                                title={mode === 'new' && outlineSource === 'point'
                                    ? 'A single point is stored as a point node'
                                    : undefined}
                                onClick={() => { setTargetShape('area'); setSelectedId(null); setDrawnPolygon([]) }}
                            >
                                Area
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
                                            placeholder={`Search ${targetShape}s`}
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
                                            {targetsLoading ? `Loading ${targetShape}s...` : `No ${targetShape}s found.`}
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
                                        placeholder={`New ${targetShape} name`}
                                        value={newName}
                                        onChange={(event) => setNewName(event.target.value)}
                                    />
                                </div>

                                <div className="field">
                                    <label className="gv-detail-label">Outline</label>

                                    {/* Same segmented control the picker uses for
                                        its basemap, so the two rows under the
                                        label read as one set of choices. */}
                                    <div className="seg gv-coord-source" role="radiogroup" aria-label="Outline source">
                                        <label className="seg-opt">
                                            <input
                                                type="radio"
                                                name="outline-source"
                                                value="photos"
                                                disabled={!hasHull}
                                                checked={outlineSource === 'photos'}
                                                onChange={() => chooseSource('photos')}
                                            />
                                            {hasHull ? `Photo outline · ${photoHull.length} corners` : 'Photo outline'}
                                        </label>
                                        <label className="seg-opt">
                                            <input
                                                type="radio"
                                                name="outline-source"
                                                value="point"
                                                disabled={!hasMean}
                                                checked={outlineSource === 'point'}
                                                onChange={() => chooseSource('point')}
                                            />
                                            Mean point
                                        </label>
                                        <label className="seg-opt">
                                            <input
                                                type="radio"
                                                name="outline-source"
                                                value="draw"
                                                checked={outlineSource === 'draw'}
                                                onChange={() => chooseSource('draw')}
                                            />
                                            Draw my own
                                        </label>
                                    </div>

                                    {/* No onChange for a derived shape: it belongs
                                        to the photos, and a stray click must not
                                        start quietly editing it. */}
                                    <PolygonPicker
                                        value={activeRing}
                                        onChange={outlineSource === 'draw' ? setDrawnPolygon : undefined}
                                        point={activePoint}
                                        photoPoints={photoPoints}
                                        fitKey={`${outlineSource}:${geotagged}`}
                                    />
                                </div>
                            </div>
                        )}
                    </section>

                    <section>
                        <div className="gv-section-head">
                            <h4>Photos</h4>
                            <span className="tag tag-neutral">{files.length}</span>
                            <div className="hr gv-section-rule" />
                            {/* Sits after the rule so it lands at the right edge
                                of the head, the way Undo/Clear do under the
                                outline picker. */}
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                disabled={files.length === 0 || running}
                                onClick={removeAllFiles}
                            >
                                Remove all
                            </button>
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
                            <span className="text-muted gv-dropzone-hint">Images only a full set of one scene</span>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
                            />
                        </div>

                        {files.length > 0 ? (
                            <p className="text-muted gv-photo-gps">
                                {gpsScanning
                                    ? 'Reading photo locations…'
                                    : geotagged === 0
                                        ? 'No photo carries GPS — draw the outline instead'
                                        : `${geotagged} of ${files.length} photos have GPS`}
                            </p>
                        ) : null}

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

                    <section>
                        <div className="gv-section-head">
                            <h4>Options</h4>
                            <div className="hr gv-section-rule" />
                        </div>

                        <div className="gv-upload-options">
                            {/* The .radio/.dot pair is the app's existing boolean
                                control (see the GIS layer library's filters)
                                a real checkbox for semantics, a styled dot for
                                the affordance. */}
                            <label className="radio">
                                <input
                                    type="checkbox"
                                    checked={wantMesh}
                                    disabled={running}
                                    onChange={(event) => setWantMesh(event.target.checked)}
                                />
                                <span className="dot" />
                                Also build a 3D mesh
                            </label>
                            <p className="text-muted gv-upload-option-help">
                                A textured mesh gives you actual geometry to measure, occlude or
                                export, but it runs as a second pass over the finished splat and
                                roughly doubles processing time. The splat itself is ready and
                                viewable before the mesh starts.
                            </p>
                        </div>
                    </section>
                </div>

                <aside className="gv-detail-rail">
                    <div className="gv-detail-head">
                        <span className="text-muted gv-detail-kicker">Job</span>
                        <span className="tag tag-accent">{targetShape}</span>
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
                        {mode === 'new' ? (
                            <div className="gv-detail-row">
                                <span className="gv-detail-label">Outline</span>
                                <span className="gv-detail-value gv-detail-value--right">
                                    {activePoint
                                        ? `Mean point · ${activePoint[1].toFixed(5)}, ${activePoint[0].toFixed(5)}`
                                        : activeRing.length === 0
                                            ? 'Not set'
                                            : outlineSource === 'photos'
                                                ? `From photos · ${activeRing.length} corners`
                                                : `Drawn · ${activeRing.length} corners`}
                                </span>
                            </div>
                        ) : null}
                        <div className="gv-detail-row">
                            <span className="gv-detail-label">Mesh</span>
                            <span className="gv-detail-value">
                                {wantMesh ? 'Yes (slower)' : 'No'}
                            </span>
                        </div>
                    </div>

                    {status ? (
                        <div className="gv-job-status">
                            <span className="gv-pulse-dot" />
                            {status}
                        </div>
                    ) : null}

                    {notice ? <p className="text-muted gv-job-notice">{notice}</p> : null}

                    {error ? <p className="gv-library-error">{error}</p> : null}

                    {!isAuthed && !result ? <SignInNotice /> : null}

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
                            {running ? 'Processing' : 'Process'}
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
