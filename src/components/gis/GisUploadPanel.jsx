import { useEffect, useMemo, useRef, useState } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import {
    dedupeByName,
    defaultOptions,
    getGisType,
    validateOptions,
    validateSelection,
} from '../../gis/gisConfig.js'
import { queueFullMessage } from '../../gis/gisErrors.js'
import { formatBytes } from '../../gis/gisFormat.js'
import GisOptionsFields from './GisOptionsFields.jsx'
import { IconClose, IconUpload } from '../icons.jsx'

/**
 * Per-tab form state lives here, not in the provider: the map must not
 * re-render when someone types in a bbox field. GisPage keys this component on
 * the active tab, so each type gets a fresh draft.
 *
 * Client phases before a job_id exists are local too — once the provider has the
 * job, this panel drops back to idle so another type can be queued in another
 * tab.
 */
export default function GisUploadPanel({ typeId, prefillBbox = null }) {
    const {
        config,
        configFallback,
        submitGisJob,
        queueFull,
    } = useGisLibrary()

    const type = useMemo(() => getGisType(typeId), [typeId])

    const [files, setFiles] = useState([])
    const [name, setName] = useState('')
    // GisPage remounts this component per tab and per prefill, so "clip to this
    // view and re-run" arrives as an initial value rather than an effect.
    const [options, setOptions] = useState(() => ({
        ...defaultOptions(typeId, config),
        ...(prefillBbox ? { bbox: prefillBbox } : {}),
    }))
    const [dragging, setDragging] = useState(false)
    const [phase, setPhase] = useState('idle') // idle | validating | creating
    const [submitError, setSubmitError] = useState('')
    const fileInputRef = useRef(null)

    // Server defaults arrive after the first render when /gis/config is slow;
    // adopt them as long as the user hasn't touched the form yet. A prefilled
    // bbox counts as touched, so it can't be clobbered by that late arrival.
    const touchedRef = useRef(Boolean(prefillBbox))

    useEffect(() => {
        if (!touchedRef.current) {
            setOptions(defaultOptions(typeId, config))
        }
    }, [typeId, config])

    const selectionProblems = useMemo(
        () => validateSelection(files, typeId, config),
        [files, typeId, config],
    )

    const optionProblems = useMemo(
        () => validateOptions(typeId, options),
        [typeId, options],
    )

    const problems = [...selectionProblems, ...optionProblems]
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

    const addFiles = (incoming) => {
        setFiles((current) => [...current, ...dedupeByName(current, Array.from(incoming))])
    }

    const removeFile = (index) => {
        setFiles((current) => current.filter((_, i) => i !== index))
    }

    const busy = phase !== 'idle'
    const canSubmit = files.length > 0 && problems.length === 0 && !busy && !queueFull

    const handleSubmit = async () => {
        setSubmitError('')
        setPhase('validating')

        if (problems.length > 0) {
            setPhase('idle')
            return
        }

        setPhase('creating')

        try {
            await submitGisJob({
                layerType: typeId,
                name: name.trim() || files[0].name.replace(/\.[^.]+$/, ''),
                files,
                options,
            })

            // Handed off — the job rail owns it from here.
            setFiles([])
            setName('')
            touchedRef.current = false
            setOptions(defaultOptions(typeId, config))
        } catch (error) {
            if (error?.name !== 'AbortError') {
                setSubmitError(error?.message || 'Could not start the job.')
            }
        } finally {
            setPhase('idle')
        }
    }

    return (
        <section>
            <div className="gv-section-head">
                <h4>{type.title}</h4>
                {files.length > 0 ? <span className="tag tag-neutral">{files.length}</span> : null}
                <div className="hr gv-section-rule" />
            </div>

            <p className="text-muted gv-gis-blurb">{type.blurb}</p>
            <p className="text-muted gv-gis-limits">{type.limitNote(config)}</p>

            {configFallback ? (
                <p className="text-muted gv-gis-limits">
                    Using built-in limits — couldn&apos;t reach the server for current limits.
                </p>
            ) : null}

            <div
                className="gv-dropzone"
                data-dragging={dragging ? '1' : '0'}
                onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    addFiles(event.dataTransfer.files)
                }}
                onClick={() => fileInputRef.current?.click()}
            >
                <IconUpload />
                <span className="gv-dropzone-text">Drop {type.label} files here or click to browse</span>
                <span className="text-muted gv-dropzone-hint">{type.dropHint}</span>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={type.accept}
                    multiple={(config.max_files?.[typeId] ?? 1) > 1}
                    onChange={(event) => { addFiles(event.target.files); event.target.value = '' }}
                />
            </div>

            {files.length > 0 ? (
                <div className="gv-file-list">
                    {files.map((file, index) => (
                        <div className="gv-file-row" key={file.name}>
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

            <div className="field gv-gis-name">
                <label className="gv-detail-label" htmlFor={`gis-name-${typeId}`}>Layer name</label>
                <input
                    id={`gis-name-${typeId}`}
                    className="input"
                    placeholder={files.length > 0 ? files[0].name.replace(/\.[^.]+$/, '') : 'Optional — defaults to the filename'}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>

            <GisOptionsFields
                typeId={typeId}
                fields={type.optionFields}
                options={options}
                onChange={(next) => { touchedRef.current = true; setOptions(next) }}
            />

            {problems.length > 0 ? (
                <ul className="gv-gis-problems">
                    {problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
            ) : null}

            {queueFull ? <p className="gv-library-error">{queueFullMessage(config)}</p> : null}

            {submitError ? <p className="gv-library-error">{submitError}</p> : null}

            <button
                type="button"
                className="btn btn-primary btn-block"
                disabled={!canSubmit}
                onClick={handleSubmit}
            >
                <IconUpload />
                {phase === 'creating' ? 'Creating job…' : `Process ${type.label}`}
            </button>

            {files.length > 0 ? (
                <p className="text-muted gv-gis-limits">
                    {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} to upload
                </p>
            ) : null}
        </section>
    )
}
