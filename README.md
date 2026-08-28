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

## Acknowledgements

This project builds on the work of many open-source projects and research teams:

### 3D Reconstruction

- **[3D Gaussian Splatting](https://github.com/graphdeco-inria/gaussian-splatting)** (Inria) — Kerbl et al., *3D Gaussian Splatting for Real-Time Radiance Field Rendering*, SIGGRAPH 2023
- **[COLMAP](https://github.com/colmap/colmap)** — Schönberger & Frahm, *Structure-from-Motion Revisited*, CVPR 2016
- **[GS2Mesh](https://github.com/yanivw12/gs2mesh)** — Wolf et al., *GS2Mesh: Surface Reconstruction from Gaussian Splatting via Novel Stereo Views*, ECCV 2024
- **[Open3D](http://www.open3d.org/)** — Zhou, Park & Koltun, *Open3D: A Modern Library for 3D Data Processing*

### Frontend

- **[React](https://react.dev/)** — Meta
- **[Three.js](https://threejs.org/)** — mrdoob et al.
- **[Spark.js](https://github.com/sparkjsdev/spark)** — Gaussian Splat WebGL renderer
- **[Leaflet](https://leafletjs.com/)** — Agafonkin et al.
- **[geotiff.js](https://github.com/geotiffjs/geotiff.js)** — Browser-side GeoTIFF reader

### Backend & GIS

- **[FastAPI](https://fastapi.tiangolo.com/)** — Ramirez
- **[GDAL](https://gdal.org/)** / **[Rasterio](https://rasterio.readthedocs.io/)** — MapBox & OSGeo
- **[GeoPandas](https://geopandas.org/)** / **[Shapely](https://shapely.readthedocs.io/)** — GeoPandas contributors
- **[PostGIS](https://postgis.net/)** — Spatial extension for PostgreSQL
- **[Laspy](https://github.com/laspy/laspy)** — LAS/LAZ point cloud I/O

### Infrastructure

- **[Modal](https://modal.com/)** — Serverless GPU compute
- **[Railway](https://railway.app/)** — Backend hosting
- **[Vercel](https://vercel.com/)** — Frontend hosting
- **[Cloudflare R2](https://developers.cloudflare.com/r2/)** — Object storage

---

## License

[GNU General Public License v3.0](LICENSE)