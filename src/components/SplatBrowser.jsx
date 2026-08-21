import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useHeaderSearch } from '../hooks/useHeaderSearch.js'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { getFileName } from '../utils.jsx'
import { IconArrowRight, IconDownload, IconNode, IconArea } from './icons.jsx'

/**
 * The library view: a flat list of splats on the left, the selected one written
 * out on the right. Shared by /, /nodes and /areas — those differ only in
 * which groups they hand in, so the filtering, the selection and the detail
 * panel are all built once, here.
 *
 * The query comes from the search box in the app header — see useHeaderSearch.
 *
 * `groups` is [{ id, label, items, empty }], already decorated by decorateSplat.
 */

const STATUS_LABEL = { ready: 'Ready', pending: 'No model' }
const STATUS_TONE = { ready: 'ok', pending: 'idle' }

/* The API stores no preview image, so the tile is generated rather than faked:
   a stable hue per name inside the theme's cyan-to-indigo band, with the type
   glyph on top. Same name, same tile, every session. */
const hueFor = (name) => {
    let hash = 0
    for (let index = 0; index < name.length; index += 1) {
        hash = (hash * 31 + name.charCodeAt(index)) % 100000
    }
    return 185 + (hash % 80)
}

/** A sentence built from the record itself — nothing here is decoration. */
const describe = (item) => {
    const shape = item.type === 'Area'
        ? `Outline of ${item.vertexCount} vertice${item.vertexCount === 1 ? '' : 's'}`
        : 'Single capture position'
    const where = item.compass ? `centred at ${item.coords}` : 'with no geometry on record'
    const model = item.modelPath
        ? `Model ${getFileName(item.modelPath)} is attached.`
        : 'No model file is attached yet.'

    return `${shape} ${where}. ${model}`
}

export function SplatRow({ item, active, onSelect }) {
    return (
        <button
            type="button"
            className="gv-lib-row"
            data-active={active ? '1' : '0'}
            onClick={onSelect}
        >
            <span className="gv-lib-thumb" style={{ '--gv-thumb-hue': hueFor(item.name) }}>
                {item.type === 'Point' ? <IconNode size={22} /> : <IconArea size={22} />}
            </span>

            <span className="gv-lib-row-main">
                <span className="gv-lib-row-name">{item.name}</span>
                <span className="gv-lib-row-meta">
                    <span className="gv-meta-chip"><i>Format:</i> {item.format}</span>
                    <span className="gv-meta-chip"><i>Type:</i> {item.type}</span>
                    <span className="gv-status" data-tone={STATUS_TONE[item.status]}>
                        {STATUS_LABEL[item.status]}
                    </span>
                </span>
            </span>

            <span className="gv-lib-row-coords">{item.compass ?? '—'}</span>
        </button>
    )
}

/**
 * Signs a download URL for the selected model up front, so the button can be a
 * plain link: resolving the URL inside the click handler would put an await
 * between the gesture and the navigation, which is what pop-up blockers stop.
 */
function useDownloadUrl(modelPath) {
    const { apiBaseUrl } = useSplatLibrary()
    // The result carries the path it was signed for, so a stale answer is
    // recognised on read instead of being cleared on the way in — which would
    // mean a setState in the effect body for every selection.
    const [signed, setSigned] = useState({ path: null, url: null, error: '' })

    useEffect(() => {
        if (!modelPath) {
            return undefined
        }

        let active = true

        fetch(`${apiBaseUrl}/splat-url?path=${encodeURIComponent(modelPath)}`)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Unable to sign that file (${response.status})`)
                }
                return response.json()
            })
            .then((data) => {
                if (active) {
                    setSigned({ path: modelPath, url: data.url, error: '' })
                }
            })
            .catch((error) => {
                if (active) {
                    setSigned({
                        path: modelPath,
                        url: null,
                        error: error instanceof Error ? error.message : 'Unavailable',
                    })
                }
            })

        return () => {
            active = false
        }
    }, [apiBaseUrl, modelPath])

    const current = signed.path === modelPath

    return { url: current ? signed.url : null, error: current ? signed.error : '' }
}

function DetailPanel({ item, loading }) {
    const { url: downloadUrl, error: downloadError } = useDownloadUrl(item?.modelPath ?? null)

    if (!item) {
        return (
            <aside className="gv-lib-panel">
                <p className="text-muted gv-lib-panel-empty">
                    {loading ? 'Loading splats…' : 'Select a splat to inspect its metadata.'}
                </p>
            </aside>
        )
    }

    return (
        <aside className="gv-lib-panel">
            <h2 className="gv-lib-panel-title">{item.name}</h2>
            <p className="gv-lib-panel-lede">{describe(item)}</p>

            <div className="gv-field">
                <span className="gv-field-label">Type</span>
                <span className="gv-field-value">
                    {item.type}
                    {item.format !== '—' ? ` (${item.format})` : ''}
                </span>
            </div>

            <div className="gv-field">
                <span className="gv-field-label">Coordinates</span>
                <span className="gv-field-value gv-mono">{item.coords}</span>
            </div>

            <div className="gv-field">
                <span className="gv-field-label">Model path</span>
                <span className="gv-field-value gv-mono gv-field-path">
                    {item.modelPath ?? 'Not available'}
                </span>
            </div>

            <div className="gv-stat-grid">
                <div className="gv-stat">
                    {/* An area has corners; a point is one position, and
                        calling that "1 vertex" reads like a broken outline. */}
                    <span className="gv-stat-label">
                        {item.type === 'Area' ? 'Vertices' : 'Positions'}
                    </span>
                    <span className="gv-stat-value">{item.vertexCount}</span>
                </div>
                <div className="gv-stat">
                    <span className="gv-stat-label">Format</span>
                    <span className="gv-stat-value">{item.format}</span>
                </div>
            </div>

            <div className="gv-lib-panel-actions">
                {item.modelPath ? (
                    <Link
                        className="btn btn-solid btn-block"
                        to="/viewer"
                        state={{ modelPath: item.modelPath, name: item.name }}
                    >
                        <IconArrowRight />
                        Open in visualizer
                    </Link>
                ) : (
                    <span className="btn btn-solid btn-block gv-btn-disabled" aria-disabled="true">
                        <IconArrowRight />
                        Open in visualizer
                    </span>
                )}

                {downloadUrl ? (
                    <a
                        className="btn btn-secondary btn-block"
                        href={downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                    >
                        <IconDownload />
                        Download raw {item.format}
                    </a>
                ) : (
                    <span className="btn btn-secondary btn-block gv-btn-disabled" aria-disabled="true">
                        <IconDownload />
                        {item.modelPath ? (downloadError || 'Preparing download…') : 'No file to download'}
                    </span>
                )}
            </div>

            <div className="gv-lib-panel-foot">
                <span className="gv-field-label">Metadata preview</span>
                <div className="gv-kv">
                    <span>Record</span>
                    <span className="gv-mono">{item.id ?? '—'}</span>
                </div>
                <div className="gv-kv">
                    <span>Geometry</span>
                    <span className="gv-mono">{item.geometryType ?? 'none'}</span>
                </div>
                <div className="gv-kv">
                    <span>CRS</span>
                    <span className="gv-mono">EPSG:4326</span>
                </div>
            </div>
        </aside>
    )
}

export default function SplatBrowser({ groups, loading, error }) {
    const { query: search } = useHeaderSearch()
    const [selectedKey, setSelectedKey] = useState(null)

    const query = search.trim().toLowerCase()

    const filtered = useMemo(
        () => groups.map((group) => ({
            ...group,
            items: query
                ? group.items.filter((item) => item.name.toLowerCase().includes(query))
                : group.items,
        })),
        [groups, query],
    )

    const visible = useMemo(() => filtered.flatMap((group) => group.items), [filtered])

    // Falls back to the first visible row so the panel is never blank while the
    // list has something in it — including right after a search narrows it.
    const selected = visible.find((item) => item.key === selectedKey) ?? visible[0] ?? null

    const showGroupHeads = groups.length > 1

    return (
        <div className="gv-browser">
            <div className="gv-browser-list">
                {error ? <p className="gv-library-error gv-browser-error">{error}</p> : null}

                {filtered.map((group) => (
                    <section key={group.id} className="gv-browser-group">
                        {showGroupHeads ? (
                            <header className="gv-browser-group-head">
                                <span>{group.label}</span>
                                <span className="gv-browser-group-count">{group.items.length}</span>
                            </header>
                        ) : null}

                        {group.items.length > 0 ? (
                            group.items.map((item) => (
                                <SplatRow
                                    key={item.key}
                                    item={item}
                                    active={selected?.key === item.key}
                                    onSelect={() => setSelectedKey(item.key)}
                                />
                            ))
                        ) : (
                            <p className="text-muted gv-browser-empty">
                                {loading
                                    ? `Loading ${group.label.toLowerCase()}…`
                                    : (group.empty ?? `No ${group.label.toLowerCase()} found.`)}
                            </p>
                        )}
                    </section>
                ))}
            </div>

            <DetailPanel item={selected} loading={loading} />
        </div>
    )
}
