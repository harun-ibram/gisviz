import { useEffect, useState } from 'react'
import { SplatLibraryContext } from './splatLibraryContext.js'

const apiBaseUrl = import.meta.env.VITE_API_URL ?? '/api'

export function SplatLibraryProvider({ children }) {
    const [nodes, setNodes] = useState([])
    const [regions, setRegions] = useState([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    useEffect(() => {
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

                const [nodesData, regionsData] = await Promise.all([
                    nodesResponse.json(),
                    regionsResponse.json(),
                ])

                if (!active) {
                    return
                }

                setNodes(nodesData)
                setRegions(regionsData)
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

        loadSplats()

        return () => {
            active = false
        }
    }, [])

    return (
        <SplatLibraryContext.Provider value={{ nodes, regions, error, loading, apiBaseUrl }}>
            {children}
        </SplatLibraryContext.Provider>
    )
}
