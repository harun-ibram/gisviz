import { useEffect, useMemo } from 'react'
import { useSplatLibrary } from '../hooks/useSplatLibrary'
import { getFileName } from '../utils'
import { decorateSplat } from './libraryUtils'
import SplatBrowser from './SplatBrowser.jsx'

function Regions() {
    const { error, loading, allRegions } = useSplatLibrary()

    useEffect(() => {
        document.title = 'Regions'
    }, [])

    const decoratedRegions = useMemo(
        () => allRegions.map((region) => decorateSplat('Region', {
            key: `region-${region.id}`,
            id: region.id,
            name: region.name ?? (region.model_path ? getFileName(region.model_path) : `Region ${region.id}`),
            modelPath: region.model_path,
            geom: region.geom,
        })),
        [allRegions],
    )

    const groups = useMemo(
        () => [{ id: 'regions', label: 'Regions', items: decoratedRegions }],
        [decoratedRegions],
    )

    return <SplatBrowser groups={groups} loading={loading} error={error} />
}

export default Regions
