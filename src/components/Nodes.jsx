import { SplatRow } from './Home'
import { useEffect, useState } from 'react'
import { decorateSplat } from './libraryUtils'
import { useSplatLibrary } from '../hooks/useSplatLibrary'
import { getFileExtension, getFileName } from '../utils'
import { useMemo } from 'react'
import { IconSearch } from './icons'

function Nodes() {
    const { error, loading, allNodes } = useSplatLibrary()
    const [selectedKey, setSelectedKey] = useState(null)
    const [search, setSearch] = useState('')

    useEffect(() => {
        document.title = 'Nodes'
    }, [])

    const decoratedNodes = useMemo(
        () => allNodes.map((node) => decorateSplat('Node', {
            key: `node-${node.node_id}`,
            name: node.model_path ? getFileName(node.model_path) : `Node ${node.node_id}`,
            modelPath: node.model_path,
            geom: node.geom,
        })),
        [allNodes],
    )

    const selected = decoratedNodes.find((item) => item.key === selectedKey) ?? decoratedNodes[0] ?? null

    const query = search.trim().toLowerCase()
    const matches = (item) => !query || item.name.toLowerCase().includes(query)
    const filteredNodes = decoratedNodes.filter(matches)

    return (
        <div className='gv-library'>
            <div className="field gv-search-field">
                <div className="gv-search-wrap">
                    <span className="gv-search-icon">
                        <IconSearch />
                    </span>
                    <input
                        className="input gv-search-input"
                        placeholder="Search nodes"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
            </div>

            <div className="gv-library-grid">
                <div className="gv-library-lists">
                    <section>
                        <div className="gv-section-head">
                            <h4>Nodes</h4>
                            <span className="tag tag-neutral">{filteredNodes.length}</span>
                            <div className="hr gv-section-rule" />
                        </div>
                        <div className="gv-section-rows">
                            {filteredNodes.length > 0 ? (
                                filteredNodes.map((item) => (
                                    <SplatRow
                                        key={item.key}
                                        item={item}
                                        active={selected?.key === item.key}
                                        onSelect={() => setSelectedKey(item.key)}
                                    />
                                ))
                            ) : (
                                <p className="text-muted gv-empty-row">{loading ? 'Loading nodes…' : 'No nodes found.'}</p>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
}


export default Nodes