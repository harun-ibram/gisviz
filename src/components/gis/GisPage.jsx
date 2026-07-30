import { useEffect, useState } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { GIS_TYPES } from '../../gis/gisConfig.js'
import { IconMap, IconPoints, IconRaster } from '../icons.jsx'
import GisUploadPanel from './GisUploadPanel.jsx'
import GisMap from './GisMap.jsx'
import GisLayerLibrary from './GisLayerLibrary.jsx'
import GisJobRail from './GisJobRail.jsx'
import GisLayerDetail from './GisLayerDetail.jsx'

const TAB_ICONS = { raster: IconRaster, map: IconMap, points: IconPoints }

/**
 * `.seg` / `.seg-opt` are radio-driven in nocturne.css (`:has(input:checked)`),
 * so this is labels wrapping radios — buttons would get no checked styling at
 * all.
 */
function GisTabStrip({ active, onChange }) {
    return (
        <div className="seg gv-gis-tabs" role="group" aria-label="Upload type">
            {GIS_TYPES.map((type) => {
                const Icon = TAB_ICONS[type.icon] ?? IconMap

                return (
                    <label className="seg-opt" key={type.id}>
                        <input
                            type="radio"
                            name="gis-type"
                            value={type.id}
                            checked={active === type.id}
                            onChange={() => onChange(type.id)}
                        />
                        <Icon />
                        {type.label}
                    </label>
                )
            })}
        </div>
    )
}

export default function GisPage() {
    const { layers, activeJob, jobPrefill, setJobPrefill } = useGisLibrary()
    const [userTab, setUserTab] = useState(GIS_TYPES[0].id)

    useEffect(() => {
        document.title = 'GIS'
    }, [])

    // "Clip to this view and re-run" targets a specific type, so its tab wins
    // until the user picks another one. Derived rather than an effect, so there
    // is no render where the wrong tab is mounted.
    const active = jobPrefill?.layerType ?? userTab

    const selectTab = (typeId) => {
        setUserTab(typeId)
        setJobPrefill(null)
    }

    const prefillBbox = jobPrefill?.layerType === active ? (jobPrefill.bbox ?? null) : null

    return (
        <div className="gv-library">
            <div className="gv-library-head">
                <div>
                    <div className="card-kicker">GIS</div>
                    <h2 className="gv-library-title">Upload and map GIS data</h2>
                    <p className="text-muted gv-library-subtitle">
                        Process rasters, LiDAR and vectors into map layers, then draw them here.
                    </p>
                </div>
                <span className="tag tag-accent">{layers.length} layers</span>
            </div>

            <GisTabStrip active={active} onChange={selectTab} />

            <div className="gv-library-grid">
                <div className="gv-library-lists">
                    {/* Keyed on the tab (and any prefill): each type gets its own
                        fresh form draft, and a new prefill remounts with the
                        bbox already in place. */}
                    <GisUploadPanel
                        key={`${active}:${jobPrefill?.nonce ?? 'none'}`}
                        typeId={active}
                        prefillBbox={prefillBbox}
                    />
                    <GisMap />
                    <GisLayerLibrary />
                </div>

                <aside className="gv-detail-rail">
                    {activeJob ? <GisJobRail /> : <GisLayerDetail />}
                </aside>
            </div>
        </div>
    )
}
