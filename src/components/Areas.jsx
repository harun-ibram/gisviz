import { useEffect, useMemo } from 'react'
import { useSplatLibrary } from '../hooks/useSplatLibrary'
import { getNodeName, isAreaNode } from '../utils'
import { decorateSplat } from './libraryUtils'
import SplatBrowser from './SplatBrowser.jsx'

// What used to be the Regions page. Regions were folded into nodes, so this is
// now the subset of nodes whose geometry is an area rather than a point — the
// same rows as before, selected by shape instead of by table.
function Areas() {
    const { error, loading, allNodes } = useSplatLibrary()

    useEffect(() => {
        document.title = 'Areas'
    }, [])

    const decoratedAreas = useMemo(
        () => allNodes.filter(isAreaNode).map((node) => decorateSplat('Area', {
            key: `node-${node.node_id}`,
            id: node.node_id,
            name: getNodeName(node),
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [allNodes],
    )

    const groups = useMemo(
        () => [{ id: 'areas', label: 'Areas', items: decoratedAreas }],
        [decoratedAreas],
    )

    return <SplatBrowser groups={groups} loading={loading} error={error} />
}

export default Areas
