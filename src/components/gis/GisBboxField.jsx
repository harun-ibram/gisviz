import { useEffect } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { validateBbox } from '../../gis/gisConfig.js'
import { IconClose, IconMap } from '../icons.jsx'

// API order throughout — [minLon, minLat, maxLon, maxLat]. The only place a
// bbox becomes Leaflet-order is the Rectangle preview, via toLeafletBounds.
const CORNERS = [
    { index: 0, label: 'Min lon (W)', placeholder: '25.9612' },
    { index: 1, label: 'Min lat (S)', placeholder: '44.3312' },
    { index: 2, label: 'Max lon (E)', placeholder: '26.2231' },
    { index: 3, label: 'Max lat (N)', placeholder: '44.5510' },
]

export default function GisBboxField({ field, value, onChange }) {
    const { viewBbox, setBboxPreview } = useGisLibrary()

    const bbox = Array.isArray(value) ? value : [null, null, null, null]
    const isSet = Array.isArray(value)
    const problems = isSet ? validateBbox(value) : []

    // Committed only — pushing every keystroke to the provider would re-render
    // the map on each digit.
    const commitPreview = (next) => {
        setBboxPreview(Array.isArray(next) && validateBbox(next).length === 0 ? next : null)
    }

    // Clearing on unmount stops a stale rectangle hanging around after a tab
    // switch.
    useEffect(() => () => setBboxPreview(null), [setBboxPreview])

    const setCorner = (index, raw) => {
        const next = [...bbox]
        next[index] = raw === '' ? null : Number(raw)

        // All four empty means "no clip", which serialises to no bbox at all
        // rather than a bbox of nulls.
        onChange(next.every((entry) => entry == null) ? null : next)
    }

    const useCurrentView = () => {
        if (viewBbox) {
            const next = viewBbox.map((n) => Number(n.toFixed(6)))
            onChange(next)
            commitPreview(next)
        }
    }

    const clear = () => {
        onChange(null)
        commitPreview(null)
    }

    return (
        <div className="gv-gis-option">
            <div className="gv-gis-option-head">
                <span className="gv-detail-label">{field.label}</span>
                <div className="gv-gis-option-actions">
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={useCurrentView}
                        disabled={!viewBbox}
                    >
                        <IconMap />
                        Use current map view
                    </button>
                    {isSet ? (
                        <button
                            type="button"
                            className="gv-tool gv-tool--sm"
                            onClick={clear}
                            aria-label="Clear bounding box"
                        >
                            <IconClose />
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="gv-bbox-grid">
                {CORNERS.map((corner) => (
                    <div className="field" key={corner.index}>
                        <label className="gv-detail-label" htmlFor={`bbox-${field.name}-${corner.index}`}>
                            {corner.label}
                        </label>
                        <input
                            id={`bbox-${field.name}-${corner.index}`}
                            className="input"
                            type="number"
                            step="any"
                            placeholder={corner.placeholder}
                            value={bbox[corner.index] ?? ''}
                            onChange={(event) => setCorner(corner.index, event.target.value)}
                            onBlur={() => commitPreview(value)}
                        />
                    </div>
                ))}
            </div>

            {field.help ? <p className="text-muted gv-gis-option-help">{field.help}</p> : null}

            {problems.length > 0 ? (
                <ul className="gv-gis-problems">
                    {problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
            ) : null}
        </div>
    )
}
