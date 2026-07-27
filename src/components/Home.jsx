import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { getFileExtension, getFileName } from '../utils.jsx'
import { IconArrowRight, IconNode, IconRegion, IconSearch } from './icons.jsx'

const collectCoordinatePairs = (coordinates, pairs = []) => {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return pairs
    }

    if (typeof coordinates[0] === 'number') {
        const [longitude, latitude] = coordinates
        pairs.push([longitude, latitude])
        return pairs
    }

    coordinates.forEach((nestedCoordinates) => {
        collectCoordinatePairs(nestedCoordinates, pairs)
    })

    return pairs
}

const formatCoordinateSummary = (geometry) => {
    const coordinatePairs = collectCoordinatePairs(geometry?.coordinates)

    if (coordinatePairs.length === 0) {
        return 'Coordinates unavailable'
    }

    const [longitudeSum, latitudeSum] = coordinatePairs.reduce(
        (accumulator, [longitude, latitude]) => [
            accumulator[0] + longitude,
            accumulator[1] + latitude,
        ],
        [0, 0],
    )

    const longitude = longitudeSum / coordinatePairs.length
    const latitude = latitudeSum / coordinatePairs.length

    return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
}

const decorateSplat = (type, { key, name, modelPath, geom }) => ({
    key,
    type,
    name,
    modelPath,
    coords: formatCoordinateSummary(geom),
    format: modelPath ? `.${getFileExtension(modelPath)}` : '—',
})

function SplatRow({ item, active, onSelect }) {
    const Icon = item.type === 'Node' ? IconNode : IconRegion

    return (
        <button type="button" className="gv-row" data-active={active ? '1' : '0'} onClick={onSelect}>
            <span className="gv-row-icon">
                <Icon />
            </span>
            <span className="gv-row-text">
                <span className="gv-row-name">{item.name}</span>
                <span className="gv-row-coords text-muted">{item.coords}</span>
            </span>
            <span className="tag tag-outline">{item.format}</span>
        </button>
    )
}

function Home() {
    const { nodes, regions, error, loading } = useSplatLibrary()
    const [search, setSearch] = useState('')
    const [selectedKey, setSelectedKey] = useState(null)

    useEffect(() => {
        document.title = 'Library'
    }, [])

    const decoratedNodes = useMemo(
        () => nodes.map((node) => decorateSplat('Node', {
            key: `node-${node.node_id}`,
            name: node.model_path ? getFileName(node.model_path) : `Node ${node.node_id}`,
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [nodes],
    )

    const decoratedRegions = useMemo(
        () => regions.map((region) => decorateSplat('Region', {
            key: `region-${region.id}`,
            name: region.name,
            modelPath: region.model_path,
            geom: region.geom,
        })),
        [regions],
    )

    const query = search.trim().toLowerCase()
    const matches = (item) => !query || item.name.toLowerCase().includes(query)
    const filteredNodes = decoratedNodes.filter(matches)
    const filteredRegions = decoratedRegions.filter(matches)

    const all = useMemo(() => [...decoratedNodes, ...decoratedRegions], [decoratedNodes, decoratedRegions])
    const selected = all.find((item) => item.key === selectedKey) ?? all[0] ?? null

    return (
        <div className="gv-library">
            <div className="gv-library-head">
                <div>
                    <div className="card-kicker">Library</div>
                    <h2 className="gv-library-title">Available splats</h2>
                    <p className="text-muted gv-library-subtitle">Select a scene to inspect its metadata, then open it in the visualizer.</p>
                </div>
                <div className="field gv-search-field">
                    <div className="gv-search-wrap">
                        <span className="gv-search-icon">
                            <IconSearch />
                        </span>
                        <input
                            className="input gv-search-input"
                            placeholder="Search splats"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>
                </div>
            </div>

            {error ? <p className="gv-library-error">{error}</p> : null}

            <div className="gv-library-grid">
                <div className="gv-library-lists">
                    <section>
                        <div className="gv-section-head">
                            <h4>Nodes</h4>
                            <span className="tag tag-neutral">{filteredNodes.length}</span>
                            <div className="hr gv-section-rule" />
                        </div>
                        <div className="gv-section-rows">
                            {filteredNodes.length > 0 ? (
                                filteredNodes.map((item) => (
                                    <SplatRow
                                        key={item.key}
                                        item={item}
                                        active={selected?.key === item.key}
                                        onSelect={() => setSelectedKey(item.key)}
                                    />
                                ))
                            ) : (
                                <p className="text-muted gv-empty-row">{loading ? 'Loading nodes…' : 'No nodes found.'}</p>
                            )}
                        </div>
                    </section>

                    <section>
                        <div className="gv-section-head">
                            <h4>Regions</h4>
                            <span className="tag tag-neutral">{filteredRegions.length}</span>
                            <div className="hr gv-section-rule" />
                        </div>
                        <div className="gv-section-rows">
                            {filteredRegions.length > 0 ? (
                                filteredRegions.map((item) => (
                                    <SplatRow
                                        key={item.key}
                                        item={item}
                                        active={selected?.key === item.key}
                                        onSelect={() => setSelectedKey(item.key)}
                                    />
                                ))
                            ) : (
                                <p className="text-muted gv-empty-row">{loading ? 'Loading regions…' : 'No regions found.'}</p>
                            )}
                        </div>
                    </section>
                </div>

                <aside className="gv-detail-rail">
                    <div className="gv-detail-head">
                        <span className="text-muted gv-detail-kicker">Selected splat</span>
                        <span className="tag tag-accent">{selected ? selected.type : '—'}</span>
                    </div>
                    {selected ? (
                        <>
                            <div className="gv-detail-name">{selected.name}</div>
                            <div className="gv-detail-rows">
                                <div className="gv-detail-row">
                                    <span className="gv-detail-label">Type</span>
                                    <span className="gv-detail-value">{selected.type}</span>
                                </div>
                                <div className="gv-detail-row">
                                    <span className="gv-detail-label">Coordinates</span>
                                    <span className="gv-detail-value gv-detail-value--right">{selected.coords}</span>
                                </div>
                                <div className="gv-detail-row">
                                    <span className="gv-detail-label">Format</span>
                                    <span className="gv-detail-value">{selected.format}</span>
                                </div>
                                <div className="gv-detail-row gv-detail-row--stack">
                                    <span className="gv-detail-label">Model path</span>
                                    <span className="gv-detail-path">{selected.modelPath ?? 'Not available'}</span>
                                </div>
                            </div>
                            {selected.modelPath ? (
                                <Link
                                    className="btn btn-primary btn-block"
                                    to="/viewer"
                                    state={{ modelPath: selected.modelPath, name: selected.name }}
                                >
                                    <IconArrowRight />
                                    Open in visualizer
                                </Link>
                            ) : (
                                <span className="btn btn-primary btn-block gv-btn-disabled" aria-disabled="true">
                                    <IconArrowRight />
                                    Open in visualizer
                                </span>
                            )}
                        </>
                    ) : (
                        <p className="text-muted gv-empty-row">{loading ? 'Loading splats…' : 'Select a splat to preview its details here.'}</p>
                    )}
                </aside>
            </div>
        </div>
    )
}

export default Home
