import { formatNumber } from '../../gis/gisFormat.js'
import { rampCss } from '../../gis/gisGeo.js'

/**
 * gis_common.py colourises with a fixed 5-stop terrain LUT normalised between p2
 * and p98 — not min/max — so this legend can be colour-exact rather than
 * decorative. min/max are shown as muted end-caps labelled "clipped", because
 * that is exactly what happens to them.
 */
export default function GisLegend({ layer }) {
    const stats = layer?.stats

    if (!stats || !Number.isFinite(stats.p2) || !Number.isFinite(stats.p98)) {
        return null
    }

    const { p2, p98, mean, min, max } = stats
    const span = p98 - p2
    const unit = layer.kind === 'dem' || layer.kind === 'dsm' ? 'elevation (m)' : 'value'

    // The mean sits wherever it sits — it is not the midpoint, and pretending it
    // is would misread every skewed terrain histogram.
    const meanOffset = span > 0 && Number.isFinite(mean)
        ? Math.min(100, Math.max(0, ((mean - p2) / span) * 100))
        : null

    return (
        <div className="gv-legend">
            <div className="gv-legend-head">
                <span className="gv-legend-title">{layer.name}</span>
                <span className="text-muted gv-legend-unit">{unit}</span>
            </div>

            <div className="gv-legend-ramp" style={{ background: rampCss() }}>
                {meanOffset != null ? (
                    <span className="gv-legend-mean" style={{ left: `${meanOffset}%` }} />
                ) : null}
            </div>

            <div className="gv-legend-ticks">
                <span>{formatNumber(p2)}</span>
                {meanOffset != null ? (
                    <span className="gv-legend-tick-mean" style={{ left: `${meanOffset}%` }}>
                        {formatNumber(mean)}
                    </span>
                ) : null}
                <span>{formatNumber(p98)}</span>
            </div>

            {Number.isFinite(min) && Number.isFinite(max) ? (
                <div className="text-muted gv-legend-clip">
                    {formatNumber(min)} – {formatNumber(max)} full range · outside p2–p98 is clipped
                </div>
            ) : null}
        </div>
    )
}
