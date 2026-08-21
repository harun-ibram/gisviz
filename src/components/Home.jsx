import { useEffect, useMemo } from 'react'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { getFileName } from '../utils.jsx'
import { decorateSplat } from './libraryUtils.jsx'
import SplatBrowser from './SplatBrowser.jsx'

/* Kept as a re-export: SplatRow used to live here, and the row is still the
   library's row wherever it is drawn. */
export { SplatRow } from './SplatBrowser.jsx'

function Home() {
    const { nodes, regions, error, loading } = useSplatLibrary()

    useEffect(() => {
        document.title = 'Library'
    }, [])

    const decoratedNodes = useMemo(
        () => nodes.map((node) => decorateSplat('Node', {
            key: `node-${node.node_id}`,
            id: node.node_id,
            name: node.model_path ? getFileName(node.model_path) : `Node ${node.node_id}`,
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [nodes],
    )

    const decoratedRegions = useMemo(
        () => regions.map((region) => decorateSplat('Region', {
            key: `region-${region.id}`,
            id: region.id,
            name: region.name,
            modelPath: region.model_path,
            geom: region.geom,
        })),
        [regions],
    )

    const groups = useMemo(
        () => [
            { id: 'nodes', label: 'Nodes', items: decoratedNodes },
            { id: 'regions', label: 'Regions', items: decoratedRegions },
        ],
        [decoratedNodes, decoratedRegions],
    )

    return <SplatBrowser groups={groups} loading={loading} error={error} />
}

export default Home
