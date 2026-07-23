import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

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

function Home() {
    const [splats, setSplats] = useState([])
    const [error, setError] = useState('')
    const [selectedSplatId, setSelectedSplatId] = useState(null)

    useEffect(() => {
        document.title = 'Home'

        const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'
        let active = true

        const loadSplats = async () => {
            try {
                const [nodesResponse, regionsResponse] = await Promise.all([
                    fetch(`${apiBaseUrl}/splat_nodes`),
                    fetch(`${apiBaseUrl}/splat_regions`),
                ])

                if (!nodesResponse.ok || !regionsResponse.ok) {
                    throw new Error('Unable to load splats from the backend.')
                }

                const [nodes, regions] = await Promise.all([
                    nodesResponse.json(),
                    regionsResponse.json(),
                ])

                if (!active) {
                    return
                }

                setSplats([
                    ...nodes.map((node) => ({
                        type: 'node',
                        id: node.node_id,
                        name: node.model_path ?? `Node ${node.node_id}`,
                        modelPath: node.model_path,
                        data: node,
                    })),
                    ...regions.map((region) => ({
                        type: 'region',
                        id: region.id,
                        name: region.name,
                        modelPath: region.model_path,
                        data: region,
                    })),
                ])
                setSelectedSplatId((currentSelectedSplatId) => {
                    const firstSplatId = nodes[0]?.node_id ?? regions[0]?.id ?? null

                    return currentSelectedSplatId ?? firstSplatId
                })
                setError('')
            } catch (loadError) {
                if (!active) {
                    return
                }

                setError(loadError instanceof Error ? loadError.message : 'Unable to load splats.')
            }
        }

        loadSplats()

        return () => {
            active = false
        }
    }, [])

    const selectedSplat = splats.find((splat) => splat.id === selectedSplatId) ?? splats[0] ?? null


    return (
        <section className="home-screen">
            <div className="copy-2">
                <div className="main-wrapper">
                    <div className="list-box list-box--home">
                        <div className="subtitle subtitle--home">
                            <span>Available Splats</span>
                            <span className="subtitle-count">{splats.length}</span>
                        </div>
                        {error ? <p className="list-error">{error}</p> : null}
                        <ul className="splat-list">
                            {splats.length > 0 ? (
                                splats.map((splat) => (
                                    <li
                                        className={`splat-item${selectedSplat?.id === splat.id ? ' splat-item--selected' : ''}`}
                                        key={`${splat.type}-${splat.id}`}
                                    >
                                        <button
                                            className="splat-link"
                                            type="button"
                                            onClick={() => setSelectedSplatId(splat.id)}
                                        >
                                            <span className="splat-name">{splat.name}</span>
                                            <span className="splat-meta">{splat.type}</span>
                                            <span className="splat-arrow" aria-hidden="true">{selectedSplat?.id === splat.id ? 'selected' : 'select'}</span>
                                        </button>
                                    </li>
                                ))
                            ) : (
                                <li className="splat-empty">No splats are available yet.</li>
                            )}
                        </ul>
                    </div>
                    <aside className="details-box">
                        <div className="subtitle subtitle--home">
                            <span>Selected Splat</span>
                            <span className="subtitle-count">{selectedSplat ? '1' : '0'}</span>
                        </div>
                        {selectedSplat ? (
                            <>
                                <div className="details-name">{selectedSplat.name}</div>
                                <dl className="details-grid">
                                    <div className="details-row">
                                        <dt>Type</dt>
                                        <dd>{selectedSplat.type}</dd>
                                    </div>
                                    <div className="details-row">
                                        <dt>Coordinates</dt>
                                        <dd>{formatCoordinateSummary(selectedSplat.data.geom)}</dd>
                                    </div>
                                    <div className="details-row">
                                        <dt>Model path</dt>
                                        <dd>{selectedSplat.modelPath ?? 'Not available'}</dd>
                                    </div>
                                </dl>
                                <p className="details-hint">Press OK to open the viewer.</p>
                            </>
                        ) : (
                            <p className="details-empty">Select a splat to preview its details here.</p>
                        )}
                        {selectedSplat ? (
                            <Link
                                className="keycap"
                                to="/viewer"
                                state={{ modelPath: selectedSplat.modelPath, name: selectedSplat.name }}
                            >
                                <aside className="letter">OK</aside>
                            </Link>
                        ) : (
                            <article className="keycap keycap--disabled" aria-disabled="true">
                                <aside className="letter">OK</aside>
                            </article>
                        )}
                    </aside>
                </div>
            </div>
        </section>
    );
}


export default Home