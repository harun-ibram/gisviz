# GISViz

Geospatial visualization and 3D reconstruction platform. Upload photos to generate 3D Gaussian Splats and meshes, process GIS data (GeoTIFF, LiDAR, OSM, GeoJSON), and explore everything on interactive maps with 2.5D building extrusions.

---

## Branches

The codebase is split across dedicated deployment branches:

| Branch | What | Deployed to |
|---|---|---|
| [`frontend`](https://github.com/harun-ibram/gisviz/tree/frontend) | React + Vite SPA (Leaflet maps, Three.js / Spark 3D viewer, GIS workspace) | **Vercel** |
| [`backend`](https://github.com/harun-ibram/gisviz/tree/backend) | FastAPI REST API (`src/`) + Modal GPU workers (`gpu/`) | **Railway** + **Modal** |

Each branch has its own README with full documentation covering architecture, setup, deployment, and API reference.

---

## Architecture Overview

```
┌─────────────┐       HTTPS        ┌──────────────────────┐
│   Frontend   │ <───────────────> │   FastAPI (Railway)   │
│   (Vercel)   │                   │       src/            │
└─────────────┘                   └──────┬──────┬─────────┘
                                         │      │
                          ┌──────────────┘      └──────────────┐
                          v                                    v
                ┌──────────────────┐                 ┌─────────────────┐
                │  PostgreSQL +    │                 │  Cloudflare R2   │
                │  PostGIS         │                 │  (S3-compatible) │
                │  (Cloud SQL)     │                 └────────┬────────┘
                └──────────────────┘                          │
                                                              │
                                              ┌───────────────┘
                                              v
                                    ┌──────────────────┐
                                    │   Modal (GPU)     │
                                    │   gpu/            │
                                    │   H100 · COLMAP   │
                                    │   3DGS · DLNR     │
                                    └──────────────────┘
```

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, Vite, Three.js, Spark.js, Leaflet, geotiff.js |
| **Backend API** | FastAPI, SQLModel, SQLAlchemy, PostGIS, pg8000 |
| **GIS Processing** | GDAL, Rasterio, GeoPandas, Shapely, Laspy, PyProj |
| **GPU Compute** | Modal, PyTorch, CUDA, COLMAP, Inria 3DGS, DLNR, Open3D |
| **Storage** | Cloudflare R2 (S3-compatible), Google Cloud SQL |
| **Auth** | JWT (PyJWT + bcrypt) |

## License

[GNU General Public License v3.0](LICENSE)