import { useEffect, useState } from 'react'
import { SplatLibraryContext } from './splatLibraryContext.js'

const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'

export function SplatLibraryProvider({ children }) {
    const [nodes, setNodes] = useState([])
    const [allNodes, setAllNodes] = useState([])
    const [regions, setRegions] = useState([])
    const [allRegions, setAllRegions] = useState([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let active = true

        const loadResults = async () => {
            try {
                const [nodesResponse, regionsResponse, allNodesResponse, allRegionsResponse] = await Promise.all([
                    fetch(`${apiBaseUrl}/splat_nodes`),
                    fetch(`${apiBaseUrl}/splat_regions`),
                    fetch(`${apiBaseUrl}/nodes`),
                    fetch(`${apiBaseUrl}/regions`)
                ])

                if (!nodesResponse.ok || !regionsResponse.ok || !allNodesResponse.ok || !allRegionsResponse.ok) {
                    throw new Error('Unable to load results from the backend.')
                }

                const [nodesData, regionsData, allNodesData, allRegionsData] = await Promise.all([
                    nodesResponse.json(),
                    regionsResponse.json(),
                    allNodesResponse.json(),
                    allRegionsResponse.json()
                ])

                if (!active) {
                    return
                }

                setNodes(nodesData)
                setRegions(regionsData)
                setAllNodes(allNodesData)
                setAllRegions(allRegionsData)
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
        <SplatLibraryContext.Provider value={{ nodes, regions, error, loading, apiBaseUrl, allNodes, allRegions }}>
            {children}
        </SplatLibraryContext.Provider>
    )
}
