import { useEffect, useMemo, useRef, useState } from 'react'
import { useGisLibrary } from '../../hooks/useGisLibrary.js'
import { useAuth } from '../../hooks/useAuth.js'
import { GIS_TYPES } from '../../gis/gisConfig.js'
import { formatCount, formatNumber, formatRelativeTime } from '../../gis/gisFormat.js'
import { isRasterLayer } from '../../gis/gisGeo.js'
import { groupVisibility } from '../../gis/gisGroups.js'
import {
    IconChevron,
    IconClose,
    IconEye,
    IconEyeOff,
    IconLayers,
    IconMap,
    IconPencil,
    IconPoints,
    IconRaster,
    IconSearch,
    IconUngroup,
} from '../icons.jsx'

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

function LayerRow({
    layer,
    visible,
    opacity,
    onToggle,
    onOpacity,
    onZoom,
    onSelect,
    onDelete,
    selected,
    canDelete,
    picking = false,
    picked = false,
    onPick,
}) {
    const Icon = isRasterLayer(layer) ? IconRaster : IconPoints

    return (
        <div className="gv-layer-row" data-active={selected ? '1' : '0'} data-picking={picking ? '1' : '0'}>
            {picking ? (
                <label className="gv-layer-pick" title="Select for grouping">
                    <input
                        type="checkbox"
                        checked={picked}
                        onChange={(event) => onPick(event.target.checked)}
                        aria-label={`Select ${layer.name} for grouping`}
                    />
                </label>
            ) : null}

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

/**
 * The group's own row. Its eye is a real checkbox in three states — all, some,
 * none — because that is what a group of layers can actually be in, and the
 * DOM's `indeterminate` is the only way to say "some" to assistive tech.
 */
function GroupHead({
    group,
    members,
    shownCount,
    state,
    opacity,
    hasRaster,
    onToggle,
    onOpacity,
    onZoom,
    onRename,
    onUngroup,
    onCollapse,
}) {
    const [draftName, setDraftName] = useState(null)
    const checkboxRef = useRef(null)

    useEffect(() => {
        if (checkboxRef.current) {
            checkboxRef.current.indeterminate = state === 'some'
        }
    }, [state])

    const commitName = () => {
        if (draftName !== null) {
            onRename(draftName)
            setDraftName(null)
        }
    }

    return (
        <div className="gv-group-head" data-state={state}>
            <label
                className="gv-layer-visibility"
                title={state === 'all' ? 'Hide all layers in this group' : 'Show all layers in this group'}
            >
                <input
                    ref={checkboxRef}
                    type="checkbox"
                    checked={state === 'all'}
                    onChange={(event) => onToggle(event.target.checked)}
                    aria-label={`Show every layer in ${group.name} on the map`}
                />
                <span className="gv-layer-eye">{state === 'none' ? <IconEyeOff /> : <IconEye />}</span>
            </label>

            <button
                type="button"
                className="gv-group-collapse"
                onClick={() => onCollapse(!group.collapsed)}
                aria-expanded={!group.collapsed}
                aria-label={group.collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                title={group.collapsed ? 'Expand group' : 'Collapse group'}
                data-open={group.collapsed ? '0' : '1'}
            >
                <IconChevron />
            </button>

            <div className="gv-group-main">
                <div className="gv-layer-name-line">
                    <span className="gv-row-icon gv-row-icon--sm"><IconLayers size={15} /></span>
                    {draftName === null ? (
                        <span className="gv-row-name">{group.name}</span>
                    ) : (
                        <input
                            className="input gv-group-rename"
                            value={draftName}
                            autoFocus
                            onChange={(event) => setDraftName(event.target.value)}
                            onBlur={commitName}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    commitName()
                                }

                                if (event.key === 'Escape') {
                                    setDraftName(null)
                                }
                            }}
                            aria-label="Group name"
                        />
                    )}
                    <span className="tag tag-accent">group</span>
                    <span className="tag tag-neutral">{members.length}</span>
                </div>
                <span className="gv-row-coords text-muted">
                    {shownCount} of {members.length} shown
                </span>
            </div>

            <div className="gv-layer-controls">
                {hasRaster ? (
                    <input
                        className="gv-opacity"
                        type="range"
                        min="0"
                        max="100"
                        value={opacity}
                        onChange={(event) => onOpacity(Number(event.target.value))}
                        aria-label={`Opacity for every raster in ${group.name}`}
                        title={`Group opacity ${opacity}%`}
                    />
                ) : null}
                <button
                    type="button"
                    className="gv-tool gv-tool--sm"
                    onClick={onZoom}
                    aria-label={`Zoom to ${group.name}`}
                    title="Zoom to group"
                >
                    <IconMap />
                </button>
                <button
                    type="button"
                    className="gv-tool gv-tool--sm"
                    onClick={() => setDraftName(group.name)}
                    aria-label={`Rename ${group.name}`}
                    title="Rename group"
                >
                    <IconPencil />
                </button>
                <button
                    type="button"
                    className="gv-tool gv-tool--sm"
                    onClick={onUngroup}
                    aria-label={`Ungroup ${group.name}`}
                    title="Ungroup — the layers stay"
                >
                    <IconUngroup />
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
        layerGroups,
        groupOfLayer,
        createLayerGroup,
        addLayersToGroup,
        removeLayersFromGroup,
        renameLayerGroup,
        deleteLayerGroup,
        setGroupCollapsed,
        toggleGroupVisibility,
        setGroupOpacity,
    } = useGisLibrary()

    const { isAuthed } = useAuth()

    const [search, setSearch] = useState('')
    const [typeFilter, setTypeFilter] = useState([])
    const [inViewOnly, setInViewOnly] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(null)
    const [deleteError, setDeleteError] = useState('')

    // Grouping is a mode rather than an always-on column: the row already
    // carries an eye, a slider and two buttons, and a permanent second checkbox
    // next to the eye is one checkbox too many to tell apart at a glance.
    const [picking, setPicking] = useState(false)
    const [pickedIds, setPickedIds] = useState([])
    const [groupName, setGroupName] = useState('')

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

    const byId = useMemo(
        () => new Map(layers.map((layer) => [layer.layer_id, layer])),
        [layers],
    )

    /**
     * `members` is every member the layer list currently holds — that is what
     * the group's eye acts on, so hiding a group hides all of it even when the
     * search box is only showing part of it. `shown` is the filtered subset,
     * which is what gets drawn as rows.
     */
    const groupRows = useMemo(() => {
        const filteredIds = new Set(filtered.map((layer) => layer.layer_id))

        return layerGroups
            .map((group) => {
                const members = group.layer_ids.map((id) => byId.get(id)).filter(Boolean)

                return {
                    group,
                    members,
                    shown: members.filter((layer) => filteredIds.has(layer.layer_id)),
                }
            })
            // A group whose layers were all filtered out (or deleted server-side
            // and gone from the list) is not worth a row.
            .filter((row) => row.shown.length > 0)
    }, [layerGroups, byId, filtered])

    // One OSM job produces two layers and a 10-file GeoJSON job produces ten;
    // a flat list makes that look like a bug. Grouped layers are drawn inside
    // their group instead, so they drop out here.
    const jobGroups = useMemo(() => {
        const byJob = new Map()

        for (const layer of filtered) {
            if (groupOfLayer.has(layer.layer_id)) {
                continue
            }

            const key = layer.job_id ?? layer.layer_id

            if (!byJob.has(key)) {
                byJob.set(key, [])
            }

            byJob.get(key).push(layer)
        }

        return [...byJob.entries()]
    }, [filtered, groupOfLayer])

    const toggleType = (typeId) => {
        setTypeFilter((current) => (current.includes(typeId)
            ? current.filter((id) => id !== typeId)
            : [...current, typeId]))
    }

    const togglePicked = (layerId, picked) => {
        setPickedIds((current) => (picked
            ? [...current, layerId]
            : current.filter((id) => id !== layerId)))
    }

    const stopPicking = () => {
        setPicking(false)
        setPickedIds([])
        setGroupName('')
    }

    const doCreateGroup = () => {
        if (pickedIds.length === 0) {
            return
        }

        createLayerGroup(groupName, pickedIds)
        stopPicking()
    }

    const doAddToGroup = (groupId) => {
        if (!groupId || pickedIds.length === 0) {
            return
        }

        addLayersToGroup(groupId, pickedIds)
        stopPicking()
    }

    const pickedGrouped = pickedIds.filter((id) => groupOfLayer.has(id))

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

    const rowProps = (layer) => ({
        layer,
        visible: visibleLayerIds.includes(layer.layer_id),
        opacity: opacityByLayer[layer.layer_id] ?? 85,
        selected: selectedLayerId === layer.layer_id,
        onToggle: (next) => toggleLayerVisibility(layer.layer_id, next),
        onOpacity: (value) => setLayerOpacity(layer.layer_id, value),
        onZoom: () => requestFit([layer.bounds]),
        onSelect: () => setSelectedLayerId(layer.layer_id),
        onDelete: () => setConfirmDelete(layer),
        canDelete: isAuthed,
        picking,
        picked: pickedIds.includes(layer.layer_id),
        onPick: (next) => togglePicked(layer.layer_id, next),
    })

    const hasRows = groupRows.length > 0 || jobGroups.length > 0

    return (
        <section>
            <div className="gv-section-head">
                <h4>Layers</h4>
                <span className="tag tag-neutral">{filtered.length}</span>
                <div className="hr gv-section-rule" />
                <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => (picking ? stopPicking() : setPicking(true))}
                    disabled={!picking && layers.length < 2}
                    title={layers.length < 2 ? 'Two or more layers are needed to make a group' : undefined}
                >
                    {picking ? 'Cancel' : 'Group layers'}
                </button>
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

            {picking ? (
                <div className="gv-group-bar">
                    <span className="gv-group-bar-count">
                        {pickedIds.length} selected
                    </span>
                    <input
                        className="input gv-group-bar-name"
                        placeholder="Group name (optional)"
                        value={groupName}
                        onChange={(event) => setGroupName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                doCreateGroup()
                            }
                        }}
                        aria-label="Name for the new group"
                    />
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={doCreateGroup}
                        disabled={pickedIds.length === 0}
                    >
                        Create group
                    </button>

                    {layerGroups.length > 0 ? (
                        <select
                            className="input gv-group-bar-select"
                            value=""
                            onChange={(event) => doAddToGroup(event.target.value)}
                            disabled={pickedIds.length === 0}
                            aria-label="Add the selected layers to an existing group"
                        >
                            <option value="">Add to group…</option>
                            {layerGroups.map((group) => (
                                <option key={group.group_id} value={group.group_id}>{group.name}</option>
                            ))}
                        </select>
                    ) : null}

                    {pickedGrouped.length > 0 ? (
                        <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                                removeLayersFromGroup(pickedGrouped)
                                stopPicking()
                            }}
                        >
                            Remove from group
                        </button>
                    ) : null}
                </div>
            ) : null}

            {layersError ? <p className="gv-library-error">{layersError}</p> : null}

            <div className="gv-section-rows">
                {!hasRows ? (
                    <p className="text-muted gv-empty-row">
                        {layersLoading ? 'Loading layers…' : 'No layers yet — process a file to make one.'}
                    </p>
                ) : null}

                {groupRows.map(({ group, members, shown }) => {
                    const memberIds = members.map((layer) => layer.layer_id)
                    const state = groupVisibility(memberIds, visibleLayerIds)
                    const shownCount = memberIds.filter((id) => visibleLayerIds.includes(id)).length
                    const rasters = members.filter(isRasterLayer)

                    return (
                        <div className="gv-group-card" key={group.group_id} data-collapsed={group.collapsed ? '1' : '0'}>
                            <GroupHead
                                group={group}
                                members={members}
                                shownCount={shownCount}
                                state={state}
                                hasRaster={rasters.length > 0}
                                opacity={opacityByLayer[rasters[0]?.layer_id] ?? 85}
                                onToggle={(next) => toggleGroupVisibility(group.group_id, next)}
                                onOpacity={(value) => setGroupOpacity(group.group_id, value)}
                                onZoom={() => requestFit(members.map((layer) => layer.bounds).filter(Boolean))}
                                onRename={(name) => renameLayerGroup(group.group_id, name)}
                                onUngroup={() => deleteLayerGroup(group.group_id)}
                                onCollapse={(collapsed) => setGroupCollapsed(group.group_id, collapsed)}
                            />

                            {group.collapsed ? null : (
                                <div className="gv-group-body">
                                    {shown.map((layer) => (
                                        <LayerRow key={layer.layer_id} {...rowProps(layer)} />
                                    ))}
                                    {shown.length < members.length ? (
                                        <p className="text-muted gv-group-hidden-note">
                                            {members.length - shown.length} more in this group, hidden by the filters
                                            — the group toggle still covers them.
                                        </p>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    )
                })}

                {jobGroups.map(([jobId, group]) => (
                    <div className="gv-layer-group" key={jobId}>
                        {group.length > 1 ? (
                            <div className="gv-layer-group-head text-muted">
                                {group.length} layers from one {group[0].layer_type} job
                            </div>
                        ) : null}

                        {group.map((layer) => (
                            <LayerRow key={layer.layer_id} {...rowProps(layer)} />
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
