/**
 * Layer groups: several layers treated as one row in the library, so toggling
 * the group shows or hides all of its members at once.
 *
 * The backend has no concept of a group (`GIS_PLAN.md` §6 knows only jobs and
 * layers), so they are a purely client-side view over the layer list and live
 * in localStorage. A layer belongs to at most one group — a layer that could be
 * in two makes "toggle the group" ambiguous.
 */

const STORAGE_KEY = 'gisviz:gis-layer-groups:v1'

export function makeGroupId() {
    return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeGroup(value) {
    if (!value || typeof value.group_id !== 'string' || !Array.isArray(value.layer_ids)) {
        return null
    }

    const layerIds = [...new Set(value.layer_ids.filter((id) => typeof id === 'string'))]

    if (layerIds.length === 0) {
        return null
    }

    return {
        group_id: value.group_id,
        name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Group',
        layer_ids: layerIds,
        collapsed: Boolean(value.collapsed),
    }
}

export function loadGroups() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)

        if (!raw) {
            return []
        }

        const parsed = JSON.parse(raw)

        if (!Array.isArray(parsed)) {
            return []
        }

        return parsed.map(normalizeGroup).filter(Boolean)
    } catch {
        // Corrupt or unavailable storage just means starting with no groups.
        return []
    }
}

export function saveGroups(groups) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(groups))
    } catch {
        // Private mode or a full quota: groups simply do not survive a reload.
    }
}

/**
 * Drops the given layers from every group and removes any group left empty —
 * used both when a layer is deleted and when layers move into another group.
 */
export function withoutLayers(groups, layerIds) {
    const drop = new Set(layerIds)

    return groups
        .map((group) => (group.layer_ids.some((id) => drop.has(id))
            ? { ...group, layer_ids: group.layer_ids.filter((id) => !drop.has(id)) }
            : group))
        .filter((group) => group.layer_ids.length > 0)
}

/** 'all' | 'some' | 'none' — drives the group's tri-state eye. */
export function groupVisibility(memberIds, visibleLayerIds) {
    if (memberIds.length === 0) {
        return 'none'
    }

    const visible = new Set(visibleLayerIds)
    const shown = memberIds.filter((id) => visible.has(id)).length

    if (shown === 0) {
        return 'none'
    }

    return shown === memberIds.length ? 'all' : 'some'
}

/** "Group 3" — the lowest number not already taken, so names stay short. */
export function defaultGroupName(groups) {
    const taken = new Set(groups.map((group) => group.name))

    for (let index = 1; index <= groups.length + 1; index += 1) {
        const candidate = `Group ${index}`

        if (!taken.has(candidate)) {
            return candidate
        }
    }

    return 'Group'
}
