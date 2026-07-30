// Deliberately duplicated from Upload.jsx:52-62 rather than extracted: the
// photo→splat flow stays untouched, so a shared helper would mean editing it.
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return '—'
    }

    if (bytes < 1024) {
        return `${bytes} B`
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatCount(count) {
    return Number.isFinite(count) ? count.toLocaleString() : '—'
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '—'
    }

    const seconds = Math.round(ms / 1000)

    if (seconds < 60) {
        return `${seconds}s`
    }

    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60

    if (minutes < 60) {
        return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
    }

    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
}

// Elevation and other stats come back as floats with far more precision than is
// meaningful on a legend tick.
export function formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) {
        return '—'
    }

    if (Math.abs(value) >= 10000) {
        return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    }

    return value.toFixed(digits).replace(/\.0+$/, '')
}

const RELATIVE_STEPS = [
    { limit: 60_000, divisor: 1000, unit: 'second' },
    { limit: 3_600_000, divisor: 60_000, unit: 'minute' },
    { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' },
    { limit: 2_592_000_000, divisor: 86_400_000, unit: 'day' },
]

export function formatRelativeTime(isoString) {
    if (!isoString) {
        return ''
    }

    const then = Date.parse(isoString)

    if (Number.isNaN(then)) {
        return ''
    }

    const elapsed = Date.now() - then

    if (elapsed < 45_000) {
        return 'just now'
    }

    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

    for (const { limit, divisor, unit } of RELATIVE_STEPS) {
        if (Math.abs(elapsed) < limit) {
            return formatter.format(-Math.round(elapsed / divisor), unit)
        }
    }

    return new Date(then).toLocaleDateString()
}
