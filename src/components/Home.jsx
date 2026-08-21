import { useEffect, useMemo } from 'react'
import { useSplatLibrary } from '../hooks/useSplatLibrary.js'
import { getNodeName, isAreaNode } from '../utils.jsx'
import { decorateSplat } from './libraryUtils.jsx'
import SplatBrowser from './SplatBrowser.jsx'

/* Kept as a re-export: SplatRow used to live here, and the row is still the
   library's row wherever it is drawn. */
export { SplatRow } from './SplatBrowser.jsx'

function Home() {
    const { nodes, error, loading } = useSplatLibrary()

    useEffect(() => {
        document.title = 'Library'
    }, [])

    // One list from one endpoint. Nodes and regions were merged into a single
    // table, so what used to be two groups fed by /splat_nodes and
    // /splat_regions is now one list split by geometry: a node carrying a
    // Polygon is what used to be a region.
    const decorated = useMemo(
        () => nodes.map((node) => decorateSplat(isAreaNode(node) ? 'Area' : 'Point', {
            key: `node-${node.node_id}`,
            id: node.node_id,
            name: getNodeName(node),
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [nodes],
    )

    const groups = useMemo(
        () => [
            { id: 'points', label: 'Points', items: decorated.filter((item) => item.type === 'Point') },
            { id: 'areas', label: 'Areas', items: decorated.filter((item) => item.type === 'Area') },
        ],
        [decorated],
    )

    return <SplatBrowser groups={groups} loading={loading} error={error} />
}

export default Home
