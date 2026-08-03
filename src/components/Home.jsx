import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

function Home() {
    const [splats, setSplats] = useState([])
    const [error, setError] = useState('')

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


    return (
        <section>
            <div className="copy-2">
                <div className="main-wrapper">
                    <div className="list-box">
                        <div className="subtitle">
                            Available Splats
                        </div>
                        <ul>
                            {splats.map((splat) => (
                                <li key={`${splat.type}-${splat.id}`}>
                                    <Link
                                        to="/viewer"
                                        state={{ modelPath: splat.modelPath, name: splat.name }}
                                    >
                                        {splat.name}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                        {error ? <p>{error}</p> : null}
                    </div>
                    <article className="keycap">
                        <aside className="letter">OK</aside>
                    </article>
                </div>
            </div>
        </section>
    );
}


export default Home