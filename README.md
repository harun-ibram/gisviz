# GISViz — Backend

Geospatial visualization and 3D reconstruction platform.  
This branch contains the **backend services**: a FastAPI application deployed on **Railway** (`src/`) and serverless GPU compute workers deployed on **Modal** (`gpu/`).

---

## Architecture

```
┌─────────────┐       HTTPS        ┌──────────────────────┐
│   Frontend   │ ◄───────────────► │   FastAPI (Railway)   │
│  (Vercel)    │                   │       src/            │
└─────────────┘                   └──────┬──────┬─────────┘
                                         │      │
                          ┌──────────────┘      └──────────────┐
                          ▼                                    ▼
                ┌──────────────────┐                 ┌─────────────────┐
                │  PostgreSQL +    │                 │  Cloudflare R2   │
                │  PostGIS         │                 │  (S3-compatible) │
                │  (Cloud SQL)     │                 └────────┬────────┘
                └──────────────────┘                          │
                                                              │
                                              ┌───────────────┘
                                              ▼
                                    ┌──────────────────┐
                                    │   Modal (GPU)     │
                                    │   gpu/            │
                                    │   H100 · COLMAP   │
                                    │   3DGS · DLNR     │
                                    └──────────────────┘
```

| Component | Role | Deployment |
|---|---|---|
| **`src/`** | REST API, auth, GIS processing, job orchestration | Railway (Docker / Nixpacks) |
| **`gpu/`** | 3D Gaussian Splatting, stereo depth meshing | Modal (serverless GPU) |
| **PostgreSQL + PostGIS** | Spatial relational storage (OSM graph, layers, jobs, users) | Google Cloud SQL |
| **Cloudflare R2** | Object storage for photos, splats, meshes, GIS assets | Cloudflare |

---

## Repository Structure

```
gisviz/
├── src/                        # Railway backend (FastAPI)
│   ├── main.py                 # App entrypoint, routes, CORS, job orchestration
│   ├── auth.py                 # JWT auth, password hashing, rate-limiting
│   ├── auth_api.py             # POST /auth/login, GET /auth/me
│   ├── models.py               # SQLModel entities (OSMNode, Job, GisJob, layers…)
│   ├── deps.py                 # R2 client, Cloud SQL connector, session dependency
│   ├── gis_api.py              # GIS REST endpoints (jobs, layers, buildings, assets)
│   ├── gis_worker.py           # Background GIS job executor
│   ├── gis_runtime.py          # GDAL/rasterio lazy loader, workspace isolation, R2 helpers
│   ├── gis_schema.py           # Idempotent DDL migrations, orphan job reaper
│   ├── gis_common.py           # Shared GIS utilities (reprojection, colorization, stats)
│   ├── building_heights.py     # LiDAR-based building height & volume calculation
│   ├── process_lidar.py        # LAS/LAZ → gridded DEM/DSM rasterization
│   ├── process_raster.py       # GeoTIFF → EPSG:4326 overlay pipeline
│   ├── process_vectors.py      # GeoJSON/Shapefile/OSM → clean vector layers
│   ├── load_gis.py             # CLI loader for local GIS data → PostGIS
│   ├── create_user.py          # CLI user management (create, reset, activate)
│   ├── requirements.txt        # Python dependencies
│   ├── Dockerfile              # Production container (python:3.13-slim + GDAL)
│   └── nixpacks.toml           # Railway Nixpacks build config
│
├── gpu/                        # Modal GPU workers
│   ├── gs2mesh_app.py          # Active: photos → 3DGS splat (.ply) + mesh (.glb)
│   ├── splat_app.py            # Legacy: photos → Nerfstudio splatfacto splat
│   ├── sugar_app.py            # Legacy: splat → SuGaR textured mesh
│   ├── README.md               # GPU pipeline documentation
│   └── GS2MESH_README.md       # GS2Mesh architecture deep-dive
│
├── scripts/                    # Database & data loading scripts
│   └── gis/
│       ├── bootstrap.sql       # Full idempotent PostGIS schema
│       └── load_data.py        # OSM XML bulk loader
├── init-scripts/               # Docker Compose DB init
├── docker-compose.yaml         # Local PostGIS dev database
├── Procfile                    # Railway process command
├── requirements.txt            # Root (delegates to src/requirements.txt)
└── LICENSE                     # GPLv3
```

---

## Core Features

### GIS Processing Pipeline (`src/`)

A unified 4-type ingest pipeline that runs as background tasks on Railway:

| Type | Input | Output |
|---|---|---|
| **Raster (TIFF)** | Single-band GeoTIFF (DEM/DSM) | EPSG:4326 GeoTIFF + colorized PNG overlay |
| **LiDAR** | LAS / LAZ point clouds | Gridded DEM or DSM raster + overlay |
| **OSM** | OSM XML / PBF extracts | Buildings & roads GeoJSON layers |
| **GeoJSON** | GeoJSON / Shapefiles | Cleaned EPSG:4326 vector layers |

**Building Heights**: When both a LiDAR surface model and building footprints are available, the system automatically computes per-building heights and volumes using zonal statistics (DSM roof sampling at 75th percentile, DEM ground sampling at 10th percentile with 2 m exterior buffer).

### 3D Reconstruction Pipeline (`gpu/`)

The active pipeline (`gs2mesh_app.py`, Modal app `gisviz-gs2mesh`) runs a single-stage reconstruction:

1. **COLMAP SfM** — Structure-from-Motion from uploaded photos
2. **3D Gaussian Splatting** — Inria 3DGS training (30k iterations)
3. **DLNR Stereo Depth** — High-frequency stereo matching on rendered novel views
4. **TSDF Fusion** — Depth map fusion into a triangle mesh via Open3D
5. **GLB Export** — Trimesh export with PBR material settings for WebGL

Runs on **NVIDIA H100 (80 GB)** with a 3-hour timeout.

### Authentication

Stateless JWT (HS256, 8h TTL) with bcrypt password hashing. In-memory brute-force throttling (5 failures / 15 min window). Public endpoints are read-only; mutations require `Authorization: Bearer <token>`.

---

## API Reference

### Auth

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | — | Authenticate, returns JWT |
| `GET` | `/auth/me` | Yes | Current user info |

### Targets & Nodes

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/nodes` | — | List all OSM / drawn target nodes |
| `GET` | `/splat_nodes` | — | List nodes that have 3D models |
| `GET` | `/nodes/{id}` | — | Get node details + GeoJSON geometry |
| `GET` | `/nodes/{id}/model_path` | — | Signed URLs for splat & mesh |
| `POST` | `/nodes` | Yes | Create a drawn target (polygon or point) |

### 3D Reconstruction Jobs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/jobs` | Yes | Create job, get presigned upload URLs |
| `POST` | `/jobs/{id}/start` | Yes | Launch Modal GPU processing |
| `GET` | `/jobs/{id}` | — | Poll job status & results |
| `POST` | `/jobs/{id}/mesh` | Yes | Retry mesh extraction |
| `POST` | `/jobs/{id}/webhook` | Secret | Modal completion callback |

### GIS Processing

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/gis/config` | — | Allowed file types, size limits |
| `POST` | `/gis/jobs` | Yes | Create GIS job, get upload URLs |
| `POST` | `/gis/jobs/{id}/start` | Yes | Start processing |
| `GET` | `/gis/jobs` | — | List GIS jobs |
| `GET` | `/gis/jobs/{id}` | — | Job details + produced layers |
| `DELETE` | `/gis/jobs/{id}` | Yes | Cancel / purge job |
| `GET` | `/gis/layers` | — | Query layers (bbox intersection) |
| `GET` | `/gis/layers/{id}` | — | Layer details + signed URLs |
| `DELETE` | `/gis/layers/{id}` | Yes | Delete layer + R2 cleanup |
| `GET` | `/gis/buildings` | — | Building footprints with heights (GeoJSON) |
| `POST` | `/gis/measure-drawn` | Yes | Trigger LiDAR measurement of drawn targets |
| `GET` | `/gis/asset-url` | — | Re-sign expired asset URLs |

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **API** | FastAPI, Pydantic, Uvicorn |
| **ORM / DB** | SQLModel, SQLAlchemy 2.0, pg8000, PostGIS |
| **Auth** | PyJWT, bcrypt |
| **Cloud SQL** | google-cloud-sql-connector (IAM auth via service account) |
| **Storage** | Cloudflare R2 via boto3 (S3-compatible) |
| **GIS** | GDAL, Rasterio, GeoPandas, Shapely, PyProj, PyOgrio, Laspy, NumPy, Pillow |
| **GPU** | Modal, PyTorch, CUDA, COLMAP, Inria 3DGS, DLNR, Open3D, Trimesh |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Cloud SQL / Supabase) |
| `GOOGLE_CREDENTIALS_B64` | Base64-encoded GCP service account JSON |
| `INSTANCE_CONNECTION_NAME` | Cloud SQL instance identifier |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET_NAME` | R2 bucket name |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `AUTH_SECRET` | JWT signing secret (fails closed if unset) |
| `WEBHOOK_SECRET` | Shared secret for Modal → API callbacks |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal authentication |

---

## Local Development

### Prerequisites

- Python 3.13+
- Docker (for local PostGIS)
- Modal CLI (`pip install modal && modal token new`)

### Database

Spin up a local PostGIS instance:

```bash
docker-compose up -d
```

This starts `postgis/postgis:16-3.4` on port **5433** with init scripts applied automatically.

### API Server

```bash
# Create and activate a virtualenv
python -m venv backend
source backend/bin/activate   # or backend\Scripts\activate on Windows

# Install dependencies
pip install -r src/requirements.txt

# Run the server
uvicorn main:app --app-dir src --host 0.0.0.0 --port 8000 --reload
```

### User Management

```bash
python src/create_user.py --email admin@example.com --create
python src/create_user.py --email admin@example.com --reset-password
python src/create_user.py --email admin@example.com --deactivate
```

### GPU Workers (Modal)

```bash
# Deploy the active pipeline
modal deploy gpu/gs2mesh_app.py

# Test locally
modal run gpu/gs2mesh_app.py
```

---

## Deployment

### Railway (`src/`)

Railway auto-deploys from this branch. The build is configured via:

- **`Procfile`** — `web: uvicorn main:app --app-dir src --host 0.0.0.0 --port $PORT`
- **`src/nixpacks.toml`** — Nixpacks build settings with system package overrides
- **`src/Dockerfile`** — Fallback Docker build (`python:3.13-slim` + `libexpat1` for GDAL)

Set all environment variables in the Railway dashboard.

### Modal (`gpu/`)

```bash
modal deploy gpu/gs2mesh_app.py
```

The worker runs on NVIDIA H100 GPUs with a pre-built container image that includes COLMAP (CUDA), 3DGS, DLNR, and Open3D.

---

## Database Schema

Key tables managed by the backend:

| Schema | Table | Purpose |
|---|---|---|
| `osm` | `nodes` | Unified targets: OSM points, drawn polygons, imported regions |
| `osm` | `ways`, `way_nodes` | OSM linear / polygon features |
| `osm` | `relations`, `relation_members` | OSM relation graph |
| `public` | `raster_layers` | Metadata for processed raster overlays |
| `public` | `vector_layers` | Metadata for processed vector layers |
| `public` | `gis_jobs` | GIS ingestion job tracking |
| `public` | `jobs` | 3D reconstruction job tracking |
| `public` | `buildings` | Building footprints with LiDAR-derived heights |
| `public` | `users` | Authentication credentials |

Schema migrations are **idempotent** and run automatically on application startup via `ensure_gis_schema()` and `ensure_auth_schema()`.

---

## License

[GNU General Public License v3.0](LICENSE)
