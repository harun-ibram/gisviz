import { useEffect, useState } from 'react'
import L from 'leaflet'
import { GeoJSON } from 'react-leaflet'
import { CORS_MESSAGE } from '../../gis/gisErrors.js'
import { vectorColor } from '../../gis/gisGeo.js'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { useAssetUrl } from './useAssetUrl.js'

/**
 * Module-scope rather than a component ref: hiding a layer unmounts this
 * component, and "hiding keeps the cache" only holds if the cache outlives it.
 * LRU-capped on both count and bytes — 120 MB of parsed FeatureCollections is
 * already a lot of heap.
 */
const MAX_CACHED_LAYERS = 6
const MAX_CACHED_BYTES = 120 * 1024 * 1024
const featureCache = new Map() // layer_id -> {data, bytes}

/** Pure read — safe to call while rendering. */
function cachePeek(layerId) {
    return featureCache.get(layerId)?.data ?? null
}

/** Marks a hit as most recently used; only called from effects. */
function cacheTouch(layerId) {
    const entry = featureCache.get(layerId)

    if (entry) {
        featureCache.delete(layerId)
        featureCache.set(layerId, entry)
    }
}

function cachePut(layerId, data, bytes) {
    featureCache.set(layerId, { data, bytes: bytes || 0 })

    let total = 0

    for (const entry of featureCache.values()) {
        total += entry.bytes
    }

    while (featureCache.size > MAX_CACHED_LAYERS || (total > MAX_CACHED_BYTES && featureCache.size > 1)) {
        const oldest = featureCache.keys().next().value
        total -= featureCache.get(oldest).bytes
        featureCache.delete(oldest)
    }
}

function styleFor(layer) {
    const color = vectorColor(layer.sublayer)

    if (layer.sublayer === 'roads') {
        return {
            color,
            weight: 1.4,
            opacity: 0.9,
            fill: false,
            // Fewer points per polyline: a visible win at 48k roads and
            // invisible at map scale.
            smoothFactor: 2,
        }
    }

    if (layer.sublayer === 'buildings') {
        return { color, weight: 0.8, opacity: 0.9, fillColor: color, fillOpacity: 0.28 }
    }

    return { color, weight: 1.2, opacity: 0.95, fillColor: color, fillOpacity: 0.22 }
}

/**
 * `interactive` exists for the polygon picker. Leaflet path clicks do not bubble
 * to the map's own click handler, so an interactive vector layer silently eats
 * every click that lands on a feature — which on a drawing surface reads as
 * "half my vertices didn't register". Passing false makes the layer pure
 * decoration and lets clicks through to the map underneath.
 */
export default function GisVectorLayer({ layer, onStatus, interactive = true }) {
    const { setFeatureFocus } = useGisLibrary()
    const { url, refresh } = useAssetUrl(layer.geojson_key, layer.geojson_url)

    // Only what this mount downloaded lives in state; a cache hit is read
    // during render, so re-showing a cached layer draws on the first frame
    // instead of after a state round-trip.
    const [fetched, setFetched] = useState(null)
    const data = fetched ?? cachePeek(layer.layer_id)

    useEffect(() => {
        if (data) {
            cacheTouch(layer.layer_id)
            return undefined
        }

        if (!url) {
            return undefined
        }

        // Toggling a layer off mid-download cancels the transfer rather than
        // paying for 21 MB nobody will look at.
        const controller = new AbortController()
        let active = true

        const load = async () => {
            onStatus?.({ kind: 'loading', message: `Loading ${layer.name}…` })

            try {
                let response = await fetch(url, { signal: controller.signal })

                // Exactly one forced re-sign, then give up — a second 403 is a
                // bucket policy problem, not an expiry one.
                if (response.status === 403) {
                    const fresh = await refresh()

                    if (fresh) {
                        response = await fetch(fresh, { signal: controller.signal })
                    }
                }

                if (!response.ok) {
                    throw new Error(`Could not download features (${response.status})`)
                }

                const parsed = await response.json()

                if (!active) {
                    return
                }

                cachePut(layer.layer_id, parsed, layer.properties?.size_bytes)
                setFetched(parsed)
                onStatus?.(null)
            } catch (error) {
                if (error?.name === 'AbortError' || !active) {
                    return
                }

                // A cross-origin failure rejects as a TypeError with no status,
                // which reads as a frontend bug when it is a bucket setting.
                const message = error instanceof TypeError
                    ? CORS_MESSAGE
                    : (error?.message || 'Could not download features.')

                onStatus?.({ kind: 'error', message })
            }
        }

        load()

        return () => {
            active = false
            controller.abort()
        }
    }, [layer.layer_id, layer.name, layer.properties?.size_bytes, url, refresh, onStatus, data])

    useEffect(() => () => onStatus?.(null), [onStatus])

    if (!data) {
        return null
    }

    return (
        <GeoJSON
            // `data` is not a reactive prop in react-leaflet; the key forces the
            // remount that actually swaps the features.
            key={layer.layer_id}
            data={data}
            pane="gis-vector"
            style={() => ({ ...styleFor(layer), interactive })}
            // Never L.marker: its default icon resolves marker-icon.png through
            // the bundler and 404s under Vite. circleMarker sidesteps the whole
            // L.Icon.Default patching ritual and draws on the canvas renderer.
            pointToLayer={(feature, latlng) => L.circleMarker(latlng, {
                radius: 4,
                ...styleFor(layer),
                interactive,
            })}
            // One layer-level handler instead of onEachFeature popup binding:
            // binding 48k Popup objects destroys the canvas renderer's advantage.
            eventHandlers={interactive ? {
                click: (event) => {
                    const properties = event.propagatedFrom?.feature?.properties

                    if (properties) {
                        setFeatureFocus({ layerId: layer.layer_id, layerName: layer.name, properties })
                    }
                },
            } : undefined}
        />
    )
}
