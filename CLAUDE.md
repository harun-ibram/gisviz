# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GISViz — a viewer for 3D Gaussian-splat reconstructions ("splats") tied to geographic locations (OSM nodes and named regions). A React/Vite frontend renders splats with Three.js/Spark and shows them alongside an OSM-derived map; a FastAPI backend serves splat metadata from a PostGIS database and hands out short-lived signed URLs to the actual `.ply`/`.splat` files stored in Cloudflare R2.

## Commands

Frontend (run from repo root):
- `npm run dev` — Vite dev server (proxies `/api/*` to `http://localhost:8000/*`, see `vite.config.js`)
- `npm run build` — production build
- `npm run lint` — ESLint (flat config, React hooks + refresh plugins)
- `npm run preview` — preview a production build

Backend (FastAPI app lives in `src/server/`, Python venv is checked into `backend/`):
- Activate the venv: `source backend/bin/activate`
- Run the API from inside `src/server/`: `uvicorn main:app --reload --port 8000` (must run with cwd = `src/server/` because `database.py` loads env vars via a relative path `../../.env`)
- No formal test suite or backend lint config exists in this repo currently.

Local database:
- `docker-compose up` starts a local PostGIS instance (`postgis/postgis:16-3.4`) on port 5433, auto-applying `init-scripts/schema.sql` on first boot.
- `scripts/load_data.py` is a one-off ingestion script: parses an OSM XML export (`map.osm`) into `osm.nodes` / `osm.ways` / `osm.way_nodes` / `osm.relations` / `osm.relation_members`, then calls the `osm.build_all_way_geometries()` / `osm.build_all_relation_geometries()` SQL functions to derive line/polygon geometry from raw node refs. It also loads a `ro.json` GeoJSON FeatureCollection into `public.regions`. Paths and DB credentials in this script are hardcoded for local one-time runs — treat it as a reference, not a reusable tool.

## Architecture

**Two independent apps in one repo**: a Vite/React SPA (`src/`, excluding `src/server/`) and a FastAPI service (`src/server/`). They share nothing except the API contract and the root `.env` file. `src/config.js` (unused by the current fetch-based data flow, historical `pg`-style DB_* vars) is legacy — the live path is `SplatLibraryProvider` → REST → FastAPI.

**Data model (PostGIS, two schemas)**:
- `osm.*` — nodes/ways/way_nodes/relations/relation_members, mirroring raw OSM XML structure. `osm.nodes.model_path` and `public.regions.model_path` are nullable pointers into R2 storage; only rows with a non-null `model_path` have an associated splat.
- `public.regions` — named polygon/multipolygon areas (e.g. countries/counties) with a JSONB `properties` bag, independent of the OSM graph.
- SQLModel classes mirroring these tables live in `src/server/models.py`, including a custom `GeometryType` SQLAlchemy type that emits raw `GEOMETRY(type, srid)` DDL for PostGIS columns.

**Backend (`src/server/`)**:
- `main.py` — FastAPI app with CRUD-style read endpoints for nodes/regions (`/nodes`, `/nodes/{id}`, `/regions`, `/regions/{id}`) plus splat-filtered variants (`/splat_nodes`, `/splat_regions` — only rows where `model_path IS NOT NULL`) and `/{nodes,regions}/{id}/model_path`, which returns a boto3-generated presigned R2 URL (1hr expiry) alongside the raw path/filename. Geometry columns are serialized via `ST_AsGeoJSON` and merged into the response dict by `_row_to_dict`.
- `database.py` — creates the SQLAlchemy engine from `DB_URL` in `.env` and yields a `Session` per-request via FastAPI `Depends`.
- CORS is currently locked to `http://localhost:5173` and the deployed Vercel origin — update `main.py` if adding new frontend origins.

**Frontend (`src/`)**:
- `App.jsx` sets up routing (`/` library view, `/viewer` splat visualizer) inside `SplatLibraryProvider`, which fetches `/api/splat_nodes` and `/api/splat_regions` once on mount and exposes `{ nodes, regions, error, loading, apiBaseUrl }` via context (`hooks/splatLibraryContext.js`, `hooks/useSplatLibrary.js`).
- `components/Home.jsx` — library/browser view; lets a user pick a node or region and navigates to `/viewer` passing `{ modelPath, name }` via router state.
- `components/SplatViewer.jsx` — the 3D viewer. Either accepts a local file upload (`.ply`/`.splat`) or, when arriving with `location.state.modelPath`, fetches a signed URL from the backend and streams that instead. Owns a manual Three.js render loop (scene/camera/renderer refs, pointer-drag orbit, wheel zoom) with `@sparkjsdev/spark`'s `SparkRenderer`/`SplatMesh` doing the actual splat rendering; cleans up GL resources and the RAF loop in effect teardowns. Renders `OSMViewer` as a side panel.
- `components/OSMViewer.jsx` — parses a static `map.osm` XML file client-side (via `DOMParser`) into an SVG map, independent of the backend OSM tables.
- No global state library; splat library data flows through the one context, viewer state is local component state.

## Environment variables (root `.env`)

Backend: `DB_URL` (SQLAlchemy/PostGIS connection string), `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` (Cloudflare R2 for splat files), `INSTANCE_CONNECTION_NAME` / `GOOGLE_CREDENTIALS_B64` (Cloud SQL connector, if used for the deployed DB instead of the local docker-compose one).
Frontend: `VITE_API_URL` (defaults to `/api`, i.e. the Vite dev proxy).

## Gitignored but present locally

`data/`, `data_output/`, `scripts/`, `docker-compose.yaml`, `init-scripts/`, and the `backend/` venv folders are all gitignored — don't assume they exist for other contributors, and don't rely on `git log`/`git diff` to show changes inside them.
