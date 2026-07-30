import { useCallback, useEffect, useMemo, useState } from 'react'
import { GeoJSON, MapContainer, Pane, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { formatBytes, formatCount } from '../../gis/gisFormat.js'
import { isRasterLayer, isVectorLayer, mapBoundsToApiBbox, toLeafletBounds, unionLeafletBounds } from '../../gis/gisGeo.js'
import GisLegend from './GisLegend.jsx'
import GisRasterOverlay from './GisRasterOverlay.jsx'
import GisVectorLayer from './GisVectorLayer.jsx'

// Known before anything downloads, which is what makes these thresholds worth
// having: feature_count comes back on the layer object.
const CONFIRM_FEATURES = 20_000
const REFUSE_FEATURES = 150_000

// Roughly what the backend's GeoJSON runs at per feature, for the confirm copy
// when properties.size_bytes is absent.
const BYTES_PER_FEATURE = 450

const BASEMAPS = [
    { id: 'dark', label: 'Dark' },
    { id: 'osm', label: 'Streets' },
    { id: 'none', label: 'None' },
]

/**
 * The standard imperative-escape pattern. `fitRequest` carries a nonce so
 * "zoom to" fires again for the same layer — a bounds-only dependency would
 * compare equal and do nothing the second time.
 */
function FitBoundsController({ fitRequest }) {
    const map = useMap()

    useEffect(() => {
        if (!fitRequest?.bounds?.length) {
            return
        }

        // fitRequest.bounds is a list in API order; the swap happens here and
        // nowhere else.
        const bounds = unionLeafletBounds(fitRequest.bounds.map(toLeafletBounds))

        if (bounds) {
            map.fitBounds(bounds, { padding: [24, 24] })
        }
    }, [fitRequest, map])

    return null
}

function ViewTracker({ onMove, onUserMove }) {
    useMapEvents({
        moveend: (event) => onMove(event.target.getBounds()),
        zoomend: (event) => onMove(event.target.getBounds()),
        dragend: () => onUserMove(),
    })

    const map = useMap()

    useEffect(() => {
        onMove(map.getBounds())
    }, [map, onMove])

    return null
}

function BasemapLayer({ basemap }) {
    if (basemap === 'dark') {
        return (
            <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                subdomains="abcd"
                maxZoom={20}
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            />
        )
    }

    if (basemap === 'osm') {
        return (
            <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                // No {s} subdomains: OSM's tile usage policy asks clients not to
                // use them.
                maxZoom={20}
                // Lets a 1 m DEM be inspected past basemap availability without
                // a wall of 404 tiles.
                maxNativeZoom={19}
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
        )
    }

    return null
}

export default function GisMap() {
    const {
        layers,
        visibleLayerIds,
        opacityByLayer,
        basemap,
        setBasemap,
        setUserMoved,
        setViewBbox,
        fitRequest,
        fitSuggestion,
        acceptFitSuggestion,
        requestFit,
        toggleLayerVisibility,
        requestJobPrefill,
        viewBbox,
        bboxPreview,
    } = useGisLibrary()

    const previewBounds = useMemo(() => toLeafletBounds(bboxPreview), [bboxPreview])

    const [confirmedHeavy, setConfirmedHeavy] = useState([])
    const [statusByLayer, setStatusByLayer] = useState({})

    const visible = useMemo(
        () => layers.filter((layer) => visibleLayerIds.includes(layer.layer_id)),
        [layers, visibleLayerIds],
    )

    const handleMove = useCallback((bounds) => {
        setViewBbox(mapBoundsToApiBbox(bounds))
    }, [setViewBbox])

    const handleUserMove = useCallback(() => setUserMoved(true), [setUserMoved])

    // Keyed on the id list rather than the layer objects: a URL refresh must not
    // invalidate the status callbacks below.
    const visibleIdKey = visible.map((layer) => layer.layer_id).join(',')

    // One stable callback per layer id, so GisVectorLayer's effect doesn't
    // re-run (and re-fetch) every time any layer's status changes.
    const statusSetters = useMemo(() => {
        const setters = {}

        for (const layer of visible) {
            setters[layer.layer_id] = (status) => setStatusByLayer((current) => {
                if (current[layer.layer_id] === status) {
                    return current
                }

                const next = { ...current }

                if (status) {
                    next[layer.layer_id] = status
                } else {
                    delete next[layer.layer_id]
                }

                return next
            })
        }

        return setters
        // `visible` is intentionally not a dependency — visibleIdKey is its
        // identity-stable projection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleIdKey])

    const rasters = visible.filter(isRasterLayer)
    const vectors = visible.filter(isVectorLayer)

    const refused = vectors.filter((layer) => (layer.feature_count ?? 0) > REFUSE_FEATURES)
    const needsConfirm = vectors.filter((layer) => {
        const count = layer.feature_count ?? 0
        return count > CONFIRM_FEATURES && count <= REFUSE_FEATURES && !confirmedHeavy.includes(layer.layer_id)
    })

    const drawable = vectors.filter((layer) => {
        const count = layer.feature_count ?? 0

        if (count > REFUSE_FEATURES) {
            return false
        }

        return count <= CONFIRM_FEATURES || confirmedHeavy.includes(layer.layer_id)
    })

    const legendLayer = rasters[rasters.length - 1] ?? null
    const statuses = Object.entries(statusByLayer)

    const estimateBytes = (layer) => layer.properties?.size_bytes
        ?? (layer.feature_count ?? 0) * BYTES_PER_FEATURE

    const clipAndRerun = (layer) => {
        // The provider stamps the nonce that remounts the panel, so this works
        // even when the target tab is already the active one.
        requestJobPrefill({
            layerType: layer.layer_type === 'geojson' ? 'geojson' : 'osm',
            bbox: viewBbox,
        })
        toggleLayerVisibility(layer.layer_id, false)
    }

    return (
        <section className="gv-gis-map">
            <div className="gv-gis-map-head">
                <h4>Map</h4>
                <span className="tag tag-neutral">{visible.length} shown</span>
                <div className="gv-gis-map-head-spacer" />
                <div className="seg" role="group" aria-label="Basemap">
                    {BASEMAPS.map((option) => (
                        <label className="seg-opt" key={option.id}>
                            <input
                                type="radio"
                                name="gis-basemap"
                                value={option.id}
                                checked={basemap === option.id}
                                onChange={() => setBasemap(option.id)}
                            />
                            {option.label}
                        </label>
                    ))}
                </div>
            </div>

            {fitSuggestion ? (
                <div className="gv-gis-map-notice">
                    <span className="gv-gis-map-notice-text">New layers are outside the current view.</span>
                    <button type="button" className="btn btn-primary" onClick={acceptFitSuggestion}>
                        {fitSuggestion.label}
                    </button>
                </div>
            ) : null}

            {needsConfirm.map((layer) => (
                <div className="gv-gis-map-notice" key={`confirm-${layer.layer_id}`}>
                    <span className="gv-gis-map-notice-text">
                        {layer.name} has {formatCount(layer.feature_count)} features
                        (~{formatBytes(estimateBytes(layer))}). Rendering may make the map sluggish.
                    </span>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => setConfirmedHeavy((current) => [...current, layer.layer_id])}
                    >
                        Render anyway
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => toggleLayerVisibility(layer.layer_id, false)}
                    >
                        Keep hidden
                    </button>
                </div>
            ))}

            {refused.map((layer) => (
                <div className="gv-gis-map-notice" data-tone="warn" key={`refused-${layer.layer_id}`}>
                    <span className="gv-gis-map-notice-text">
                        {layer.name} has {formatCount(layer.feature_count)} features — too many to draw
                        in the browser. Clip it to a smaller area and re-run, or download it instead.
                    </span>
                    <button type="button" className="btn btn-primary" onClick={() => clipAndRerun(layer)}>
                        Clip to this view and re-run
                    </button>
                    {layer.geojson_url ? (
                        <a className="btn btn-secondary" href={layer.geojson_url} target="_blank" rel="noreferrer">
                            Download
                        </a>
                    ) : null}
                </div>
            ))}

            {statuses.map(([layerId, status]) => (
                <div className="gv-job-status" data-tone={status.kind} key={`status-${layerId}`}>
                    {status.kind === 'loading' ? <span className="gv-pulse-dot" /> : null}
                    {status.message}
                </div>
            ))}

            <div className="gv-gis-map-canvas" data-basemap={basemap}>
                <MapContainer
                    center={[45.9432, 24.9668]}
                    zoom={6}
                    // One canvas per pane instead of 48k SVG nodes.
                    preferCanvas
                    // Past basemap availability on purpose — see maxNativeZoom.
                    maxZoom={20}
                    className="gv-leaflet"
                >
                    <BasemapLayer basemap={basemap} />

                    {/* Explicit z-order, so a raster mounted later can never
                        cover the vectors drawn over it. */}
                    <Pane name="gis-raster" style={{ zIndex: 400 }} />
                    <Pane name="gis-vector" style={{ zIndex: 450 }} />

                    <FitBoundsController fitRequest={fitRequest} />
                    <ViewTracker onMove={handleMove} onUserMove={handleUserMove} />

                    {rasters.map((layer) => (
                        <GisRasterOverlay
                            key={layer.layer_id}
                            layer={layer}
                            opacity={opacityByLayer[layer.layer_id] ?? 85}
                        />
                    ))}

                    {drawable.map((layer) => (
                        <GisVectorLayer
                            key={layer.layer_id}
                            layer={layer}
                            onStatus={statusSetters[layer.layer_id]}
                        />
                    ))}

                    {/* The clip bbox being composed in the upload panel. */}
                    {previewBounds ? (
                        <Rectangle
                            bounds={previewBounds}
                            pane="gis-vector"
                            pathOptions={{ color: '#d2cefd', weight: 1.4, dashArray: '6 4', fillOpacity: 0.06 }}
                        />
                    ) : null}

                    {/* bounds_geojson is already lon/lat — Leaflet's GeoJSON
                        layer handles that itself, so no swap here. */}
                    {refused.map((layer) => (layer.bounds_geojson ? (
                        <GeoJSON
                            key={`outline-${layer.layer_id}`}
                            data={layer.bounds_geojson}
                            pane="gis-vector"
                            style={{ color: '#b5abfc', weight: 1, dashArray: '4 4', fill: false }}
                        />
                    ) : null))}
                </MapContainer>
            </div>

            {legendLayer ? <GisLegend layer={legendLayer} /> : null}

            {visible.length === 0 ? (
                <p className="text-muted gv-gis-map-empty">
                    Nothing shown yet — tick a layer below, or upload a file to make one.
                </p>
            ) : (
                <button
                    type="button"
                    className="btn btn-secondary gv-gis-map-fit"
                    onClick={() => requestFit(visible.map((layer) => layer.bounds).filter(Boolean))}
                >
                    Fit to visible layers
                </button>
            )}
        </section>
    )
}
