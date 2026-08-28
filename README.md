# GISViz — Frontend

Geospatial visualization and 3D reconstruction platform.  
This branch contains the **frontend application**: a React + Vite SPA deployed on **Vercel**.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Vercel (SPA)                        │
│                                                      │
│   React 19 · Vite · Leaflet · Three.js · Spark.js   │
│                                                      │
└──────────┬────────────────────────┬──────────────────┘
           │ REST API               │ Presigned URLs
           ▼                        ▼
┌────────────────────┐    ┌─────────────────┐
│  FastAPI Backend    │    │  Cloudflare R2   │
│  (Railway)          │    │  (direct upload  │
│                     │    │   & download)    │
└────────────────────┘    └─────────────────┘
```

| Component | Role | Deployment |
|---|---|---|
| **React SPA** | UI, 3D viewer, map, GIS workspace, auth | Vercel |
| **FastAPI Backend** | REST API, job orchestration, GIS processing | Railway (`backend` branch) |
| **Cloudflare R2** | Object storage (photos, splats, meshes, GIS assets) | Cloudflare |

---

## Repository Structure

```
gisviz/
├── src/
│   ├── main.jsx                        # React entry point
│   ├── App.jsx                         # Root shell, routing, provider hierarchy, nav rail
│   ├── App.css                         # Main application stylesheet
│   ├── config.js                       # Environment variable exports
│   ├── utils.jsx                       # Path helpers, node classification utilities
│   │
│   ├── components/
│   │   ├── Home.jsx                    # Library page — splat models split by Points/Areas
│   │   ├── Nodes.jsx                   # Full node catalog page
│   │   ├── Areas.jsx                   # Polygon-only node catalog page
│   │   ├── SplatBrowser.jsx            # Two-column list + detail inspector
│   │   ├── SplatViewer.jsx             # 3D Gaussian Splat & mesh viewer (Three.js + Spark)
│   │   ├── SplatMap.jsx                # Leaflet location map for the 3D viewer
│   │   ├── MapBuildings.jsx            # 2.5D building extrusions on Leaflet
│   │   ├── MapAutoResize.jsx           # ResizeObserver → Leaflet invalidateSize bridge
│   │   ├── Upload.jsx                  # Photo upload workflow & job orchestration
│   │   ├── PolygonPicker.jsx           # Interactive polygon drawing tool with undo/redo
│   │   ├── icons.jsx                   # SVG icon library
│   │   ├── libraryUtils.jsx            # Coordinate formatting & splat decoration
│   │   │
│   │   ├── auth/
│   │   │   ├── AuthCorner.jsx          # Fixed auth FAB + account popover
│   │   │   ├── LoginDialog.jsx         # Modal login form
│   │   │   └── SignInNotice.jsx        # Inline sign-in prompt banner
│   │   │
│   │   └── gis/
│   │       ├── GisPage.jsx             # GIS workspace container with tab strip
│   │       ├── GisUploadPanel.jsx      # GIS file upload form (TIFF/OSM/GeoJSON/LiDAR)
│   │       ├── GisMap.jsx              # Interactive Leaflet map with raster & vector layers
│   │       ├── GisVectorLayer.jsx      # GeoJSON layer renderer with LRU cache
│   │       ├── GisRasterOverlay.jsx    # GeoTIFF PNG overlay with reactive opacity
│   │       ├── GisLayerLibrary.jsx     # Layer management table (visibility, groups, search)
│   │       ├── GisLayerDetail.jsx      # Layer inspector sidebar (stats, downloads, props)
│   │       ├── GisJobRail.jsx          # Real-time job progress tracker
│   │       ├── GisLegend.jsx           # Terrain color ramp legend
│   │       ├── GisOptionsFields.jsx    # Dynamic form generator for layer options
│   │       ├── GisBboxField.jsx        # Bounding box coordinate picker
│   │       └── useAssetUrl.js          # Signed URL hook with auto-refresh
│   │
│   ├── auth/
│   │   └── authApi.js                  # Login & session API client factory
│   │
│   ├── gis/
│   │   ├── gisApi.js                   # GIS REST API client (jobs, layers, config)
│   │   ├── gisConfig.js                # Type schemas, validation rules, default options
│   │   ├── gisErrors.js                # Error classification, retry actions, status labels
│   │   ├── gisFormat.js                # Formatting (bytes, counts, durations, timestamps)
│   │   ├── gisGeo.js                   # Coordinate conversions, convex hull, color palettes
│   │   ├── gisGroups.js                # localStorage-persisted layer grouping manager
│   │   ├── basemaps.js                 # Leaflet tile layer definitions (Dark / OSM)
│   │   ├── buildings.js                # Building height/volume math & polygon containment
│   │   ├── geotiffHeights.js           # Browser-side GeoTIFF sampling engine
│   │   ├── photoGps.js                 # EXIF GPS extraction from uploaded photos
│   │   └── uploadGisFiles.js           # Parallel chunked file uploader with retry
│   │
│   ├── hooks/
│   │   ├── AuthProvider.jsx            # Auth context (JWT, login, logout, token refresh)
│   │   ├── GisLibraryProvider.jsx      # GIS state engine (jobs, layers, groups, map view)
│   │   ├── SplatLibraryProvider.jsx    # Splat node catalog context
│   │   ├── HeaderSearchProvider.jsx    # Scoped search query context
│   │   ├── useDragSize.js              # Drag-to-resize hook for split panes
│   │   ├── useAuth.js                  # Auth context consumer hook
│   │   ├── useGisLibrary.js            # GIS context consumer hook
│   │   ├── useSplatLibrary.js          # Splat context consumer hook
│   │   └── useHeaderSearch.js          # Search context consumer hook
│   │
│   ├── theme/
│   │   ├── nocturne.css                # Base design system (tokens, typography, buttons)
│   │   └── aurora.css                  # Active color palette (navy/cyan)
│   │
│   └── assets/                         # Static images (hero, logos)
│
├── public/
│   ├── favicon.svg
│   ├── icons.svg
│   └── overlays/                       # Static overlay assets
│
├── index.html                          # HTML entry point
├── package.json                        # Dependencies & scripts
├── vite.config.js                      # Vite config with API proxy
├── vercel.json                         # SPA fallback rewrites
├── eslint.config.js                    # ESLint + React Hooks rules
└── LICENSE                             # GPLv3
```

---

## Core Features

### 3D Gaussian Splat Viewer

Interactive WebGL visualizer for `.ply` Gaussian Splats and `.glb` textured meshes, built on Three.js and Spark.js.

- First-person camera with WASD flight controls, E/Q vertical lift, Shift sprint
- Pointer-lock mouse look (click to lock, Escape to release)
- Scroll and button zoom dolly
- X/Y/Z rotation sliders for manual alignment
- Splat / Mesh view mode toggle
- 2.5D building extrusions colored by volume quartiles
- Resizable split view with a Leaflet location map

### GIS Workspace

A full-featured geospatial data management workspace supporting four ingest types:

| Type | Accepted Formats |
|---|---|
| **Raster (TIFF)** | `.tif`, `.tiff` |
| **LiDAR** | `.las`, `.laz` |
| **OSM** | `.osm`, `.pbf` |
| **GeoJSON** | `.geojson`, `.json`, `.shp` (+ sidecar) |

Features:
- Drag-and-drop upload with client-side validation against backend limits
- Real-time job progress stepper with live log streaming
- Smart error cards with contextual one-click retry actions (e.g., "retry as DSM", "double cell size")
- Interactive Leaflet map with raster overlays and canvas-rendered vector layers
- Layer library with visibility toggles, opacity sliders, custom groups, and search
- Layer inspector with statistics (min/max/mean/percentiles), downloads, and feature properties
- Spatial filtering ("only in current view") via bounding box intersection
- Performance guards prompting before rendering layers with >20k features
- Browser-side GeoTIFF height sampling for building footprints without backend round-trips
- LRU in-memory vector layer cache (6 layers / 120 MB)

### Photo Upload & 3D Reconstruction

End-to-end workflow for creating 3D models from photo sets:

- Target selection: pick an existing node/area or create a new point/polygon
- Interactive polygon drawing with undo/redo and GIS layer overlay
- Automatic EXIF GPS extraction with convex hull and mean point computation
- Batch parallel upload to Cloudflare R2 (concurrency = 6)
- Optional mesh generation toggle
- Real-time job status polling until completion
- Direct navigation to the viewer on success

### Authentication

- JWT-based stateless auth persisted in localStorage
- Fixed bottom-left auth FAB with pulsing status indicator
- Modal login dialog with password visibility toggle
- Inline sign-in banners before protected actions
- Auto-session validation on startup

### 2.5D Building Rendering

Cabinet-projection building extrusions on Leaflet maps:

- Metric heights from LiDAR backend data or browser-side GeoTIFF sampling
- Roof/wall polygon generation with pixel-accurate height offsets
- Painter's algorithm sorting (north-to-south occlusion)
- Volume quartile color ramp with interactive legend
- Gated above zoom level 14 for performance

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Framework** | React 19, Vite |
| **Routing** | react-router-dom v7 |
| **3D Rendering** | Three.js, @sparkjsdev/spark (Gaussian Splat renderer) |
| **Maps** | Leaflet, react-leaflet |
| **GeoTIFF** | geotiff.js (browser-side COG sampling) |
| **EXIF** | exifr (GPS metadata extraction) |
| **Styling** | CSS custom properties, design tokens (Nocturne + Aurora themes) |
| **Analytics** | @vercel/analytics |
| **Linting** | ESLint with react-hooks and react-refresh plugins |

---

## Environment Variables

| Variable | Description |
|---|---|
| `VITE_API_URL` | Backend API base URL (e.g., `https://gisviz-production.up.railway.app/`) |

---

## Local Development

### Prerequisites

- Node.js 18+
- Backend API running locally or accessible remotely

### Setup

```bash
# Install dependencies
npm install

# Start dev server (port 5173)
npm run dev
```

The Vite dev server proxies `/api` requests to `http://localhost:8000` (the local backend), stripping the `/api` prefix.

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Run ESLint |

---

## Deployment

Vercel auto-deploys from this branch. Configuration:

- **`vercel.json`** — SPA fallback: all routes rewrite to `/index.html`
- **Build command**: `vite build`
- **Output directory**: `dist/`

Set `VITE_API_URL` in the Vercel dashboard environment variables.

---

## Design System

The UI is built on two CSS theme layers:

- **Nocturne** (`src/theme/nocturne.css`) — Base design tokens, typography (Inter), form components, elevation scale, spacing scale
- **Aurora** (`src/theme/aurora.css`) — Active palette overriding Nocturne with deep navy backgrounds and cyan/mint accents

Key design tokens:

| Token | Value | Purpose |
|---|---|---|
| `--color-bg` | `#070a12` | Page background |
| `--color-surface` | `#0e1420` | Card/panel surfaces |
| `--color-accent` | `#4cc4f7` | Primary accent (cyan) |
| `--color-accent-2` | `#2ed3b7` | Secondary accent (mint) |
| `--gv-ok` | `#35d39a` | Success status |
| `--gv-warn` | `#f2b035` | Warning status |
| `--gv-danger` | `#ff6f6f` | Error status |
| `--gv-rail-w` | `58px` | Navigation rail width |

---

## Application Routes

| Path | Component | Description |
|---|---|---|
| `/` | `Home` | Library — 3D models grouped by Points/Areas |
| `/viewer` | `SplatViewer` | Interactive 3D splat/mesh viewer |
| `/upload` | `Upload` | Photo upload and reconstruction workflow |
| `/gis` | `GisPage` | GIS data workspace |
| `/nodes` | `Nodes` | Full node catalog |
| `/areas` | `Areas` | Polygon-only node catalog |

---

## License

[GNU General Public License v3.0](LICENSE)