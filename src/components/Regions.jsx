import { SplatRow } from './Home'
import { useEffect, useState } from 'react'
import { decorateSplat } from './libraryUtils'
import { useSplatLibrary } from '../hooks/useSplatLibrary'
import { getFileExtension, getFileName } from '../utils'
import { useMemo } from 'react'
import { IconSearch } from './icons'

function Regions() {
    const { error, loading, allRegions } = useSplatLibrary()
    const [selectedKey, setSelectedKey] = useState(null)
    const [search, setSearch] = useState('')

    useEffect(() => {
        document.title = 'Regions'
    }, [])

    const decoratedRegions = useMemo(
        () => allRegions.map((region) => decorateSplat('Region', {
            key: `region-${region.id}`,
            name: region.name ?? (region.model_path ? getFileName(region.model_path) : `Region ${region.id}`),
            modelPath: region.model_path,
            geom: region.geom,
        })),
        [allRegions],
    )

    const selected = decoratedRegions.find((item) => item.key === selectedKey) ?? decoratedRegions[0] ?? null

    const query = search.trim().toLowerCase()
    const matches = (item) => !query || item.name.toLowerCase().includes(query)
    const filteredRegions = decoratedRegions.filter(matches)

    return (
        <div className='gv-library'>
            <div className="field gv-search-field">
                <div className="gv-search-wrap">
                    <span className="gv-search-icon">
                        <IconSearch />
                    </span>
                    <input
                        className="input gv-search-input"
                        placeholder="Search regions"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
            </div>

            <div className="gv-library-grid">
                <div className="gv-library-lists">
                    <section>
                        <div className="gv-section-head">
                            <h4>Regions</h4>
                            <span className="tag tag-neutral">{filteredRegions.length}</span>
                            <div className="hr gv-section-rule" />
                        </div>
                        <div className="gv-section-rows">
                            {filteredRegions.length > 0 ? (
                                filteredRegions.map((item) => (
                                    <SplatRow
                                        key={item.key}
                                        item={item}
                                        active={selected?.key === item.key}
                                        onSelect={() => setSelectedKey(item.key)}
                                    />
                                ))
                            ) : (
                                <p className="text-muted gv-empty-row">{loading ? 'Loading regions…' : 'No regions found.'}</p>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
}


export default Regions