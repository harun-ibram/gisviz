import GisBboxField from './GisBboxField.jsx'

/**
 * The only component that branches per option type, and it branches on
 * `control` — not on layer type. Adding an option to GIS_TYPES needs no change
 * here unless it needs a fourth control.
 */
export default function GisOptionsFields({ typeId, fields, options, onChange }) {
    if (fields.length === 0) {
        return null
    }

    return (
        <div className="gv-gis-options">
            {fields.map((field) => {
                const value = options?.[field.name]
                const set = (next) => onChange({ ...options, [field.name]: next })
                const id = `gis-option-${typeId}-${field.name}`

                if (field.control === 'select') {
                    return (
                        <div className="gv-gis-option" key={field.name}>
                            <div className="field">
                                <label className="gv-detail-label" htmlFor={id}>{field.label}</label>
                                <select
                                    id={id}
                                    className="input"
                                    value={value ?? ''}
                                    onChange={(event) => set(event.target.value)}
                                >
                                    {field.options.map((option) => (
                                        <option value={option.value} key={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </div>
                            {field.help ? <p className="text-muted gv-gis-option-help">{field.help}</p> : null}
                        </div>
                    )
                }

                if (field.control === 'number') {
                    return (
                        <div className="gv-gis-option" key={field.name}>
                            <div className="field">
                                <label className="gv-detail-label" htmlFor={id}>{field.label}</label>
                                <input
                                    id={id}
                                    className="input"
                                    type="number"
                                    min={field.min}
                                    max={field.max}
                                    step={field.step}
                                    value={value ?? ''}
                                    onChange={(event) => set(event.target.value === '' ? '' : Number(event.target.value))}
                                />
                            </div>
                            {field.help ? (
                                <p className="text-muted gv-gis-option-help">
                                    {field.help} Range {field.min}–{field.max}.
                                </p>
                            ) : null}
                        </div>
                    )
                }

                if (field.control === 'bbox') {
                    return (
                        <GisBboxField
                            key={field.name}
                            field={field}
                            value={value ?? null}
                            onChange={set}
                        />
                    )
                }

                return null
            })}
        </div>
    )
}
