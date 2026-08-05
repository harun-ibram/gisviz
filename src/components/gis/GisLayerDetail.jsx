import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { formatBytes, formatCount, formatNumber, formatRelativeTime } from '../../gis/gisFormat.js'
import { isRasterLayer } from '../../gis/gisGeo.js'
import { IconArrowRight, IconMap } from '../icons.jsx'

function Row({ label, value, stack = false }) {
    if (value == null || value === '') {
        return null
    }

    return (
        <div className={`gv-detail-row${stack ? ' gv-detail-row--stack' : ''}`}>
            <span className="gv-detail-label">{label}</span>
            <span className={`gv-detail-value${stack ? '' : ' gv-detail-value--right'}`}>{value}</span>
        </div>
    )
}

function FeatureProps({ focus, onClear }) {
    const entries = Object.entries(focus.properties)
        // label_lon/label_lat are placement hints from process_vectors, not data
        // the user asked about.
        .filter(([key, value]) => value != null && value !== '' && !['label_lon', 'label_lat'].includes(key))
        .slice(0, 24)

    return (
        <div className="gv-feature-props">
            <div className="gv-detail-head">
                <span className="text-muted gv-detail-kicker">Clicked feature</span>
                <button type="button" className="btn btn-ghost" onClick={onClear}>Clear</button>
            </div>
            <div className="text-muted gv-gis-limits">{focus.layerName}</div>

            {entries.length === 0 ? (
                <p className="text-muted gv-gis-limits">This feature carries no properties.</p>
            ) : (
                <div className="gv-detail-rows">
                    {entries.map(([key, value]) => (
                        <Row key={key} label={key} value={String(value)} />
                    ))}
                </div>
            )}
        </div>
    )
}

export default function GisLayerDetail() {
    const {
        layers,
        selectedLayerId,
        requestFit,
        toggleLayerVisibility,
        visibleLayerIds,
        featureFocus,
        setFeatureFocus,
        layersTotal,
    } = useGisLibrary()

    const layer = layers.find((entry) => entry.layer_id === selectedLayerId) ?? null

    if (featureFocus) {
        return <FeatureProps focus={featureFocus} onClear={() => setFeatureFocus(null)} />
    }

    if (!layer) {
        return (
            <>
                <div className="gv-detail-head">
                    <span className="text-muted gv-detail-kicker">Layer</span>
                    <span className="tag tag-neutral">{layersTotal} total</span>
                </div>
                <p className="text-muted gv-gis-limits">
                    Pick a layer to see its coordinate system, statistics and downloads.
                </p>
            </>
        )
    }

    const visible = visibleLayerIds.includes(layer.layer_id)
    const stats = layer.stats ?? {}
    const raster = isRasterLayer(layer)

    return (
        <>
            <div className="gv-detail-head">
                <span className="text-muted gv-detail-kicker">Layer</span>
                <span className="tag tag-accent">{layer.layer_type}</span>
            </div>

            <div className="gv-detail-name">{layer.name}</div>

            <div className="gv-detail-rows">
                <Row label="Type" value={raster ? 'Raster' : 'Vector'} />
                <Row label="Kind" value={layer.kind ?? layer.sublayer} />
                <Row label="Source" value={layer.source} />
                <Row label="Source CRS" value={layer.src_crs} />
                <Row label="Created" value={formatRelativeTime(layer.created_at)} />

                {raster ? (
                    <>
                        <Row label="p2 – p98" value={Number.isFinite(stats.p2)
                            ? `${formatNumber(stats.p2)} – ${formatNumber(stats.p98)}`
                            : null}
                        />
                        <Row label="Min / max" value={Number.isFinite(stats.min)
                            ? `${formatNumber(stats.min)} / ${formatNumber(stats.max)}`
                            : null}
                        />
                        <Row label="Mean" value={Number.isFinite(stats.mean) ? formatNumber(stats.mean) : null} />
                        <Row label="Samples" value={Number.isFinite(stats.count) ? formatCount(stats.count) : null} />
                        <Row label="Bands" value={layer.properties?.band_count} />
                        <Row label="Nodata" value={layer.properties?.nodata != null
                            ? String(layer.properties.nodata)
                            : null}
                        />
                    </>
                ) : (
                    <>
                        <Row label="Features" value={formatCount(layer.feature_count ?? 0)} />
                        <Row label="Size" value={layer.properties?.size_bytes
                            ? formatBytes(layer.properties.size_bytes)
                            : null}
                        />
                        <Row label="Clipped to" value={layer.properties?.bbox_applied
                            ? layer.properties.bbox_applied.map((n) => formatNumber(n, 3)).join(', ')
                            : null}
                        />
                    </>
                )}

                <Row
                    label="Bounds"
                    stack
                    value={layer.bounds ? layer.bounds.map((n) => formatNumber(n, 4)).join(', ') : null}
                />
            </div>

            <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => toggleLayerVisibility(layer.layer_id, !visible)}
            >
                {visible ? 'Hide on map' : 'Show on map'}
            </button>

            <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => requestFit([layer.bounds])}
                disabled={!layer.bounds}
            >
                <IconMap />
                Zoom to layer
            </button>

            {layer.geotiff_url ? (
                <a className="btn btn-secondary btn-block" href={layer.geotiff_url} target="_blank" rel="noreferrer">
                    <IconArrowRight />
                    Download GeoTIFF (WGS84)
                </a>
            ) : null}

            {layer.geojson_url ? (
                <a className="btn btn-secondary btn-block" href={layer.geojson_url} target="_blank" rel="noreferrer">
                    <IconArrowRight />
                    Download GeoJSON
                </a>
            ) : null}

            {layer.overlay_url ? (
                <a className="btn btn-secondary btn-block" href={layer.overlay_url} target="_blank" rel="noreferrer">
                    <IconArrowRight />
                    Download overlay PNG
                </a>
            ) : null}
        </>
    )
}
