export const getFileName = (path) => path?.split('/').pop() ?? ''

export const getFileExtension = (fileName) => fileName?.split('.').pop()?.toLowerCase() ?? ''

// Nodes and regions are one table now: a node's geometry is either a Point or a
// Polygon/MultiPolygon, and that is the only thing that distinguishes what used
// to be two types. Everything that used to branch on "node vs region" branches
// on this instead.
export const isAreaNode = (node) => {
    const type = node?.geom?.type
    return type === 'Polygon' || type === 'MultiPolygon'
}

// `name` is generated in the database from tags->>'name', so it is present for
// anything a user named and null for a bare OSM vertex — hence the fallbacks.
export const getNodeName = (node) =>
    node?.name || (node?.model_path ? getFileName(node.model_path) : `Node ${node?.node_id}`)
