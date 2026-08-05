import { useEffect, useMemo, useRef, useState } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { useAuth } from '../../hooks/useAuth.js'
import { GIS_TYPES } from '../../gis/gisConfig.js'
import { formatCount, formatNumber, formatRelativeTime } from '../../gis/gisFormat.js'
import { isRasterLayer } from '../../gis/gisGeo.js'
import { IconClose, IconEye, IconEyeOff, IconMap, IconRaster, IconPoints, IconSearch } from '../icons.jsx'

function layerMeta(layer) {
    if (isRasterLayer(layer)) {
        const { p2, p98 } = layer.stats ?? {}

        if (Number.isFinite(p2) && Number.isFinite(p98)) {
            const unit = layer.kind === 'dem' || layer.kind === 'dsm' ? ' m' : ''
            return `${formatNumber(p2)}–${formatNumber(p98)}${unit}`
        }

        return 'raster'
    }

    return `${formatCount(layer.feature_count ?? 0)} features`
}

function LayerRow({ layer, visible, opacity, onToggle, onOpacity, onZoom, onSelect, onDelete, selected, canDelete }) {
    const Icon = isRasterLayer(layer) ? IconRaster : IconPoints

    return (
        <div className="gv-layer-row" data-active={selected ? '1' : '0'}>
            {/* A real checkbox, shown as an eye — keyboard and screen readers get
                the semantics, everyone else gets the affordance. */}
            <label
                className="gv-layer-visibility"
                title={visible ? 'Hide on map' : 'Show on map'}
            >
                <input
                    type="checkbox"
                    checked={visible}
                    onChange={(event) => onToggle(event.target.checked)}
                    aria-label={`Show ${layer.name} on the map`}
                />
                <span className="gv-layer-eye">{visible ? <IconEye /> : <IconEyeOff />}</span>
            </label>

            <button type="button" className="gv-layer-main" onClick={onSelect}>
                <span className="gv-layer-name-line">
                    <span className="gv-row-icon gv-row-icon--sm"><Icon /></span>
                    <span className="gv-row-name">{layer.name}</span>
                    <span className="tag tag-accent">{layer.layer_type}</span>
                    {layer.kind || layer.sublayer ? (
                        <span className="tag tag-outline">{layer.kind ?? layer.sublayer}</span>
                    ) : null}
                </span>
                <span className="gv-row-coords text-muted">
                    {layerMeta(layer)} · {formatRelativeTime(layer.created_at)}
                </span>
            </button>

            <div className="gv-layer-controls">
                {isRasterLayer(layer) ? (
                    <input
                        className="gv-opacity"
                        type="range"
                        min="0"
                        max="100"
                        value={opacity}
                        onChange={(event) => onOpacity(Number(event.target.value))}
                        aria-label={`Opacity for ${layer.name}`}
                        title={`Opacity ${opacity}%`}
                    />
                ) : null}
                <button
                    type="button"
                    className="gv-tool gv-tool--sm"
                    onClick={onZoom}
                    aria-label={`Zoom to ${layer.name}`}
                    title="Zoom to layer"
                >
                    <IconMap />
                </button>
                <button
                    type="button"
                    className="gv-tool gv-tool--sm"
                    onClick={onDelete}
                    disabled={!canDelete}
                    aria-label={`Delete ${layer.name}`}
                    title={canDelete ? 'Delete layer' : 'Sign in to delete'}
                >
                    <IconClose />
                </button>
            </div>
        </div>
    )
}

export default function GisLayerLibrary() {
    const {
        layers,
        layersLoading,
        layersError,
        visibleLayerIds,
        toggleLayerVisibility,
        opacityByLayer,
        setLayerOpacity,
        requestFit,
        deleteLayer,
        selectedLayerId,
        setSelectedLayerId,
        refreshLayers,
        viewBbox,
    } = useGisLibrary()

    const { isAuthed } = useAuth()

    const [search, setSearch] = useState('')
    const [typeFilter, setTypeFilter] = useState([])
    const [inViewOnly, setInViewOnly] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(null)
    const [deleteError, setDeleteError] = useState('')

    // The bbox filter is server-side (ST_Intersects), so toggling it is a
    // re-query rather than a client-side filter. The provider already loads the
    // unfiltered list on mount, so only an active filter re-queries here.
    const filterTouched = useRef(false)

    useEffect(() => {
        if (!inViewOnly && !filterTouched.current) {
            return undefined
        }

        filterTouched.current = true
        const controller = new AbortController()

        const load = async () => {
            await refreshLayers(
                inViewOnly && viewBbox ? { bbox: viewBbox.map((n) => n.toFixed(6)) } : {},
                controller.signal,
            )
        }

        load()

        return () => controller.abort()
        // viewBbox deliberately omitted: re-querying on every pan while the
        // filter is on would fire one request per map move.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inViewOnly, refreshLayers])

    const query = search.trim().toLowerCase()

    const filtered = useMemo(() => layers.filter((layer) => {
        if (typeFilter.length > 0 && !typeFilter.includes(layer.layer_type)) {
            return false
        }

        if (!query) {
            return true
        }

        return layer.name?.toLowerCase().includes(query)
            || layer.source?.toLowerCase().includes(query)
            || layer.layer_id?.toLowerCase().includes(query)
    }), [layers, typeFilter, query])

    // One OSM job produces two layers and a 10-file GeoJSON job produces ten;
    // a flat list makes that look like a bug.
    const groups = useMemo(() => {
        const byJob = new Map()

        for (const layer of filtered) {
            const key = layer.job_id ?? layer.layer_id

            if (!byJob.has(key)) {
                byJob.set(key, [])
            }

            byJob.get(key).push(layer)
        }

        return [...byJob.entries()]
    }, [filtered])

    const toggleType = (typeId) => {
        setTypeFilter((current) => (current.includes(typeId)
            ? current.filter((id) => id !== typeId)
            : [...current, typeId]))
    }

    const doDelete = async () => {
        const layer = confirmDelete

        setDeleteError('')

        try {
            await deleteLayer(layer.layer_id)
            setConfirmDelete(null)
        } catch (error) {
            setDeleteError(error?.message || 'Could not delete that layer.')
        }
    }

    return (
        <section>
            <div className="gv-section-head">
                <h4>Layers</h4>
                <span className="tag tag-neutral">{filtered.length}</span>
                <div className="hr gv-section-rule" />
            </div>

            <div className="gv-gis-filters">
                <div className="field gv-search-field">
                    <div className="gv-search-wrap">
                        <span className="gv-search-icon"><IconSearch /></span>
                        <input
                            className="input gv-search-input"
                            placeholder="Search layers"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>
                </div>

                <div className="seg" role="group" aria-label="Filter by type">
                    {GIS_TYPES.map((type) => (
                        <label className="seg-opt" key={type.id}>
                            <input
                                type="checkbox"
                                checked={typeFilter.includes(type.id)}
                                onChange={() => toggleType(type.id)}
                            />
                            {type.label}
                        </label>
                    ))}
                </div>

                <label className="radio gv-gis-inview">
                    <input
                        type="checkbox"
                        checked={inViewOnly}
                        onChange={(event) => setInViewOnly(event.target.checked)}
                    />
                    <span className="dot" />
                    Only in current view
                </label>
            </div>

            {layersError ? <p className="gv-library-error">{layersError}</p> : null}

            <div className="gv-section-rows">
                {groups.length === 0 ? (
                    <p className="text-muted gv-empty-row">
                        {layersLoading ? 'Loading layers…' : 'No layers yet — process a file to make one.'}
                    </p>
                ) : groups.map(([jobId, group]) => (
                    <div className="gv-layer-group" key={jobId}>
                        {group.length > 1 ? (
                            <div className="gv-layer-group-head text-muted">
                                {group.length} layers from one {group[0].layer_type} job
                            </div>
                        ) : null}

                        {group.map((layer) => (
                            <LayerRow
                                key={layer.layer_id}
                                layer={layer}
                                visible={visibleLayerIds.includes(layer.layer_id)}
                                opacity={opacityByLayer[layer.layer_id] ?? 85}
                                selected={selectedLayerId === layer.layer_id}
                                onToggle={(next) => toggleLayerVisibility(layer.layer_id, next)}
                                onOpacity={(value) => setLayerOpacity(layer.layer_id, value)}
                                onZoom={() => requestFit([layer.bounds])}
                                onSelect={() => setSelectedLayerId(layer.layer_id)}
                                onDelete={() => setConfirmDelete(layer)}
                                canDelete={isAuthed}
                            />
                        ))}
                    </div>
                ))}
            </div>

            {confirmDelete ? (
                <div className="dialog-backdrop" role="dialog" aria-modal="true">
                    <div className="dialog">
                        <div className="dialog-title">Delete this layer?</div>
                        <p className="dialog-body">
                            {confirmDelete.name} and its stored files will be removed. This can&apos;t be undone.
                        </p>
                        {deleteError ? <p className="gv-library-error">{deleteError}</p> : null}
                        <div className="dialog-actions">
                            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>
                                Keep it
                            </button>
                            <button type="button" className="btn btn-primary" onClick={doDelete}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </section>
    )
}
