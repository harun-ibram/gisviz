import { useMemo, useRef } from 'react'
import { ImageOverlay } from 'react-leaflet'
import { toLeafletBounds } from '../../gis/gisGeo.js'
import { useAssetUrl } from './useAssetUrl.js'

/**
 * `url`, `bounds` and `opacity` are all reactive props in react-leaflet, so the
 * opacity slider and a URL refresh both work without remounting the overlay —
 * which is what keeps dragging the slider flicker-free.
 *
 * No `crossOrigin`: a plain <img> load needs no CORS. (The GeoJSON fetch does.)
 */
export default function GisRasterOverlay({ layer, opacity }) {
    const { url, refresh } = useAssetUrl(layer.overlay_key, layer.overlay_url)

    // One forced re-sign per mount at most: if the refreshed URL also fails,
    // retrying on every error event would spin.
    const retriedRef = useRef(false)

    const bounds = useMemo(() => toLeafletBounds(layer.bounds), [layer.bounds])

    if (!url || !bounds) {
        return null
    }

    return (
        <ImageOverlay
            url={url}
            bounds={bounds}
            opacity={opacity / 100}
            pane="gis-raster"
            eventHandlers={{
                error: () => {
                    if (!retriedRef.current) {
                        retriedRef.current = true
                        refresh().catch(() => {})
                    }
                },
            }}
        />
    )
}
