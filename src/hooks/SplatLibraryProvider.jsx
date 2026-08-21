import { useEffect, useState } from 'react'
import { SplatLibraryContext } from './splatLibraryContext.js'

const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'

// Two fetches, not four: /regions and /splat_regions are gone, because a region
// was a node with an area and osm.nodes now holds both shapes. Consumers that
// used to read `regions` filter `nodes` with isAreaNode instead.
export function SplatLibraryProvider({ children }) {
    const [nodes, setNodes] = useState([])
    const [allNodes, setAllNodes] = useState([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let active = true

        const loadResults = async () => {
            try {
                const [nodesResponse, allNodesResponse] = await Promise.all([
                    fetch(`${apiBaseUrl}/splat_nodes`),
                    fetch(`${apiBaseUrl}/nodes`)
                ])

                if (!nodesResponse.ok || !allNodesResponse.ok) {
                    throw new Error('Unable to load results from the backend.')
                }

                const [nodesData, allNodesData] = await Promise.all([
                    nodesResponse.json(),
                    allNodesResponse.json()
                ])

                if (!active) {
                    return
                }

                setNodes(nodesData)
                setAllNodes(allNodesData)
                setError('')
            } catch (loadError) {
                if (!active) {
                    return
                }

                setError(loadError instanceof Error ? loadError.message : 'Unable to load splats.')
            } finally {
                if (active) {
                    setLoading(false)
                }
            }
        }

        loadResults()

        return () => {
            active = false
        }
    }, [])

    return (
        <SplatLibraryContext.Provider value={{ nodes, error, loading, apiBaseUrl, allNodes }}>
            {children}
        </SplatLibraryContext.Provider>
    )
}
