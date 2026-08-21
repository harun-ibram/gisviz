import { useEffect, useMemo } from 'react'
import { useSplatLibrary } from '../hooks/useSplatLibrary'
import { getFileName } from '../utils'
import { decorateSplat } from './libraryUtils'
import SplatBrowser from './SplatBrowser.jsx'

function Nodes() {
    const { error, loading, allNodes } = useSplatLibrary()

    useEffect(() => {
        document.title = 'Nodes'
    }, [])

    const decoratedNodes = useMemo(
        () => allNodes.map((node) => decorateSplat('Node', {
            key: `node-${node.node_id}`,
            id: node.node_id,
            name: node.model_path ? getFileName(node.model_path) : `Node ${node.node_id}`,
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [allNodes],
    )

    const groups = useMemo(
        () => [{ id: 'nodes', label: 'Nodes', items: decoratedNodes }],
        [decoratedNodes],
    )

    return <SplatBrowser groups={groups} loading={loading} error={error} />
}

export default Nodes
