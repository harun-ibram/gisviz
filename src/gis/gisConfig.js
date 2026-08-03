import { formatBytes } from './gisFormat.js'

/**
 * Mirrors the documented `GET /gis/config` response byte-for-byte, so the page
 * still validates sensibly when that endpoint is unreachable. Consumers never
 * see null — the provider merges the live response over this.
 */
export const FALLBACK_GIS_CONFIG = {
    layer_types: ['tiff', 'osm', 'geojson', 'lidar'],
    accepted_extensions: {
        tiff: ['.tif', '.tiff'],
        lidar: ['.laz', '.las'],
        osm: ['.osm', '.pbf', '.xml', '.osm.pbf'],
        geojson: ['.geojson', '.json'],
    },
    max_files: { tiff: 1, lidar: 1, osm: 1, geojson: 10 },
    max_size_bytes: { tiff: 314572800, lidar: 524288000, osm: 262144000, geojson: 104857600 },
    max_raster_pixels: 16000000,
    max_lidar_cells: 25000000,
    max_queue: 3,
    url_ttl_seconds: 3600,
    defaults: { tiff: { kind: 'dem' }, lidar: { kind: 'dem', cell: 1.0 } },
}

/**
 * UI concerns only — every limit is read from the server config at render time.
 * `optionFields` drive the forms so no per-type form is hand-written; only
 * GisOptionsFields branches, on `control`.
 */
export const GIS_TYPES = [
    {
        id: 'tiff',
        label: 'TIFF',
        icon: 'raster',
        title: 'GeoTIFF raster',
        blurb: 'Produces one raster layer, reprojected to WGS84 and colourised as a PNG overlay. '
            + 'The file must carry a CRS — a plain TIFF with no georeferencing cannot be placed on a map.',
        accept: '.tif,.tiff,image/tiff',
        dropHint: 'One .tif or .tiff · must be georeferenced',
        limitNote: (config) => `Up to ${formatBytes(config.max_size_bytes.tiff)} and `
            + `${(config.max_raster_pixels / 1e6).toFixed(0)} megapixels after reprojection.`,
        optionFields: [
            {
                name: 'kind',
                label: 'Kind',
                control: 'select',
                default: 'dem',
                options: [
                    { value: 'dem', label: 'DEM — terrain surface' },
                    { value: 'dsm', label: 'DSM — surface incl. buildings' },
                    { value: 'raster', label: 'Raster — generic values' },
                ],
                help: 'DEM and DSM get the terrain colour ramp and an elevation legend; raster is treated as generic values.',
            },
        ],
    },
    {
        id: 'osm',
        label: 'OSM',
        icon: 'map',
        title: 'OpenStreetMap extract',
        blurb: 'Produces two layers from one job — buildings and roads — as separate GeoJSON '
            + 'FeatureCollections. Seeing two rows appear from a single upload is expected, not a bug.',
        accept: '.osm,.pbf,.xml,.osm.pbf',
        dropHint: 'One .osm, .pbf, .xml or .osm.pbf',
        limitNote: (config) => `Up to ${formatBytes(config.max_size_bytes.osm)}. `
            + 'A bounding box is pushed into the OGR read, so clipping large extracts is much faster than filtering after.',
        optionFields: [
            {
                name: 'bbox',
                label: 'Clip to bounding box',
                control: 'bbox',
                default: null,
                help: 'Optional. Pushed into the OGR read rather than applied afterwards — recommended above roughly 50 MB.',
            },
        ],
    },
    {
        id: 'geojson',
        label: 'GeoJSON',
        icon: 'points',
        title: 'GeoJSON vectors',
        blurb: 'Produces one layer per file, so ten files give ten layers grouped under one job. '
            + 'Points render as circle markers.',
        accept: '.geojson,.json,application/geo+json,application/json',
        dropHint: 'Up to 10 .geojson or .json files',
        limitNote: (config) => `Up to ${config.max_files.geojson} files, `
            + `${formatBytes(config.max_size_bytes.geojson)} each.`,
        optionFields: [
            {
                name: 'bbox',
                label: 'Clip to bounding box',
                control: 'bbox',
                default: null,
                help: 'Optional. Applied to every file in the job.',
            },
        ],
    },
    {
        id: 'lidar',
        label: 'LiDAR',
        icon: 'points',
        title: 'LiDAR point cloud',
        blurb: 'Produces one raster layer gridded from the point cloud. A DEM needs classified '
            + 'ground returns (class 2) — unclassified tiles must use DSM, which grids the highest return instead.',
        accept: '.laz,.las',
        dropHint: 'One .laz or .las',
        limitNote: (config) => `Up to ${formatBytes(config.max_size_bytes.lidar)}, and `
            + `${(config.max_lidar_cells / 1e6).toFixed(0)}M grid cells — a small cell size over a large tile exceeds that fast.`,
        optionFields: [
            {
                name: 'kind',
                label: 'Kind',
                control: 'select',
                default: 'dem',
                options: [
                    { value: 'dem', label: 'DEM — ground returns (class 2)' },
                    { value: 'dsm', label: 'DSM — highest return' },
                ],
                help: 'Pick DSM for tiles whose points are not classified.',
            },
            {
                name: 'cell',
                label: 'Cell size (m)',
                control: 'number',
                default: 1.0,
                min: 0.1,
                max: 50,
                step: 0.1,
                help: 'Grid resolution in metres. Halving it quadruples the cell count.',
            },
        ],
    },
]

export const GIS_TYPE_IDS = GIS_TYPES.map((type) => type.id)

export function getGisType(typeId) {
    return GIS_TYPES.find((type) => type.id === typeId) ?? GIS_TYPES[0]
}

/** Server defaults win over the schema defaults. */
export function defaultOptions(typeId, config) {
    const type = getGisType(typeId)
    const serverDefaults = config?.defaults?.[typeId] ?? {}

    const options = {}

    for (const field of type.optionFields) {
        options[field.name] = field.name in serverDefaults
            ? serverDefaults[field.name]
            : field.default
    }

    return options
}

/** Omits `bbox` entirely when null rather than sending an explicit null. */
export function serializeOptions(typeId, options) {
    const type = getGisType(typeId)
    const payload = {}

    for (const field of type.optionFields) {
        const value = options?.[field.name]

        if (field.control === 'bbox') {
            if (Array.isArray(value) && value.length === 4 && value.every((n) => Number.isFinite(Number(n)))) {
                payload.bbox = value.map(Number)
            }

            continue
        }

        if (field.control === 'number') {
            payload[field.name] = Number(value)
            continue
        }

        payload[field.name] = value
    }

    return payload
}

export function validateOptions(typeId, options) {
    const type = getGisType(typeId)
    const problems = []

    for (const field of type.optionFields) {
        const value = options?.[field.name]

        if (field.control === 'select') {
            if (!field.options.some((option) => option.value === value)) {
                problems.push(`${field.label} must be one of ${field.options.map((o) => o.value).join(', ')}.`)
            }

            continue
        }

        if (field.control === 'number') {
            const numeric = Number(value)

            if (!Number.isFinite(numeric)) {
                problems.push(`${field.label} must be a number.`)
            } else if (numeric < field.min || numeric > field.max) {
                problems.push(`${field.label} must be between ${field.min} and ${field.max}.`)
            }

            continue
        }

        if (field.control === 'bbox' && value != null) {
            problems.push(...validateBbox(value))
        }
    }

    return problems
}

export function validateBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
        return ['Bounding box needs four values.']
    }

    const numbers = bbox.map(Number)

    if (!numbers.every(Number.isFinite)) {
        return ['Bounding box needs four numbers — clear it to skip clipping.']
    }

    const [minLon, minLat, maxLon, maxLat] = numbers
    const problems = []

    if (minLon < -180 || maxLon > 180) {
        problems.push('Longitude must be between -180 and 180.')
    }

    if (minLat < -90 || maxLat > 90) {
        problems.push('Latitude must be between -90 and 90.')
    }

    if (minLon >= maxLon) {
        problems.push('Min longitude must be less than max longitude.')
    }

    if (minLat >= maxLat) {
        problems.push('Min latitude must be less than max latitude.')
    }

    return problems
}

/**
 * Longest-suffix match, so `.osm.pbf` wins over `.pbf` for a file named
 * `valencia.osm.pbf`. A plain `split('.').pop()` would see only `pbf`.
 */
export function matchExtension(filename, extensions) {
    const lower = filename.toLowerCase()

    return [...extensions]
        .sort((a, b) => b.length - a.length)
        .find((extension) => lower.endsWith(extension.toLowerCase())) ?? null
}

/**
 * Mirrors every documented 400 from `POST /gis/jobs` so a bad selection costs no
 * upload. `max_raster_pixels` / `max_lidar_cells` need the file header and are
 * left to the server's preflight step.
 */
export function validateSelection(files, typeId, config) {
    const problems = []

    if (files.length === 0) {
        return problems
    }

    const type = getGisType(typeId)
    const maxFiles = config?.max_files?.[typeId]
    const maxSize = config?.max_size_bytes?.[typeId]
    const extensions = config?.accepted_extensions?.[typeId] ?? []

    if (Number.isFinite(maxFiles) && files.length > maxFiles) {
        problems.push(maxFiles === 1
            ? `${type.label} accepts one file; you selected ${files.length}.`
            : `${type.label} accepts ${maxFiles} files; you selected ${files.length}.`)
    }

    for (const file of files) {
        if (extensions.length > 0 && !matchExtension(file.name, extensions)) {
            problems.push(`${file.name} is not a ${type.label} file — accepted: ${extensions.join(', ')}.`)
        }

        if (Number.isFinite(maxSize) && file.size > maxSize) {
            problems.push(`${file.name} is ${formatBytes(file.size)}; the limit for ${type.label} is ${formatBytes(maxSize)}.`)
        }
    }

    // Keyed on filename alone — a deliberate divergence from Upload.jsx:186,
    // which keys on `${name}:${size}`. `upload_urls` is a {filename: url} map,
    // so two different files both named tile.tif would collide onto one
    // presigned URL and silently overwrite each other.
    const seen = new Set()

    for (const file of files) {
        if (seen.has(file.name)) {
            problems.push(`Two files are named ${file.name} — filenames must be unique within a job.`)
        }

        seen.add(file.name)
    }

    return problems
}

/** Same filename-only key, applied when adding to the selection. */
export function dedupeByName(existing, incoming) {
    const seen = new Set(existing.map((file) => file.name))

    return incoming.filter((file) => {
        if (seen.has(file.name)) {
            return false
        }

        seen.add(file.name)
        return true
    })
}
