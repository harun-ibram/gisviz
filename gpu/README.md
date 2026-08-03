# Splat ingestion pipeline

Turns user-uploaded photos into a Gaussian splat and attaches it to a map
feature. GPU work runs on **Modal** (serverless, scale-to-zero); the FastAPI
backend on Railway only orchestrates and writes to the database.

```
client            Railway (FastAPI)            Modal (GPU)               R2
  | POST /jobs ---------> create job row
  | <-- job_id + presigned PUT URLs
  | PUT photos --------------------------------------------------------> inputs/{job_id}/
  | POST /jobs/{id}/start -> spawn process() --> pull photos <---------- inputs/{job_id}/
  |                                              COLMAP + splatfacto
  |                                              upload scene ---------> models/{job_id}/scene.ply
  |                          webhook <---------- POST (secret-signed)
  |                          set model_path, status=done
  | GET /jobs/{id} (poll) -> status
```

The worker (`gpu/splat_app.py`) never touches the DB — it only reads/writes R2
and calls the webhook, which is what sets `model_path`.

## Deploy

1. **Apply the schema** — the `public.jobs` table
   (`scripts/gis/schema.sql`) must exist in the Cloud SQL database.

2. **Create Modal secrets** (dashboard or `modal secret create`):
   - `gisviz-r2` → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
   - `gisviz-webhook` → `JOB_WEBHOOK_SECRET`

3. **Deploy the GPU app** (publishes the `gisviz-splat` app / `process` function
   the backend looks up):
   ```
   modal deploy gpu/splat_app.py
   ```

4. **Set backend env vars on Railway** (in addition to the existing R2/DB ones):
   - `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` — so FastAPI can spawn Modal jobs
   - `JOB_WEBHOOK_SECRET` — must match the Modal `gisviz-webhook` secret
   - `BACKEND_PUBLIC_URL` — the backend's public URL, e.g.
     `https://gisviz-backend.up.railway.app` (used to build the webhook URL Modal calls)

## Frontend API contract

1. `POST /jobs` with `{ "target_type": "node"|"region", "target_id": "...", "filenames": [...] }`
   → `{ "job_id", "input_prefix", "upload_urls": { filename: presigned_put_url } }`
2. `PUT` each photo to its `upload_urls[filename]` (raw file body, no auth header).
3. `POST /jobs/{job_id}/start` → `{ "job_id", "status": "processing" }`
4. Poll `GET /jobs/{job_id}` until `status` is `done` or `failed`.
5. On `done`, the existing `/splat_nodes` + `/splat-url` path serves the new
   `model_path` — no viewer changes needed.

## Georeferencing (EXIF GPS)

A COLMAP reconstruction has arbitrary scale, position and orientation, which is
why splats otherwise need hand-placing in the viewer. If the uploaded photos
carry EXIF GPS, the worker solves that automatically:

1. GPS is read from the **original** photos, before `ns-process-data` re-encodes
   them (that re-encode can drop EXIF entirely).
2. Those fixes are written as COLMAP's `ref_images.txt` and fed to
   `colmap model_aligner --ref_is_gps 1 --alignment_type enu --estimate_scale 1`,
   which fits a 7-DOF similarity by RANSAC.
3. `transforms.json` is regenerated from the aligned model (`--skip-colmap`), so
   training happens in ENU metres — 1 unit = 1 m, gravity-aligned, north-oriented
   — rather than COLMAP's arbitrary frame.

The webhook payload gains `georeferenced`, `gps_photos`, `total_photos`, and the
`sim3` transform when it succeeds. **Surface the counts in the UI**: an unaligned
splat looks identical to an aligned one until you try to measure it.

Every step is best-effort. Fewer than 3 photos with GPS, a failed RANSAC fit, or
a filename-mapping mismatch all leave the splat unaligned rather than failing
the job.

Two traps worth knowing:

- **Altitude is ellipsoidal, not orthometric.** EXIF `GPSAltitude` is WGS84
  height; LiDAR DEMs are geoid-referenced (NAVD88 etc.). The difference is tens
  of metres and varies regionally. Use GPS for horizontal position and scale, and
  take ground elevation from your own DEM.
- **Absolute placement stays metre-sloppy** (phone GPS is 3–10 m, worse in urban
  canyons). *Scale* comes out far better, since it is fitted across the whole
  camera baseline rather than any single fix.

## Open items

- **Splat format**: the worker exports nerfstudio's `.ply` (3DGS). Confirm this
  matches what the frontend viewer loads (`.ply` vs `.splat`/`.ksplat`); adjust
  the `ns-export` step in `splat_app.py` if not.
- **COLMAP is built from source, not apt.** The distro package has no CUDA
  support, so COLMAP falls back to SiftGPU-over-OpenGL and aborts in a headless
  container (`Check failed: context_.create()` in `opengl_utils.cc`). The image
  compiles COLMAP 3.8 with `-DCUDA_ENABLED=ON`, which `#ifdef`s that GL context
  out and runs SIFT on CUDA. Consequences to know about:
  - First `modal deploy` after touching the apt/build layers recompiles COLMAP
    (~15–25 min); it's cached after that.
  - The build targets sm_75/80/86 (T4/A100/A10G). Using a different GPU means
    adding its arch to `CMAKE_CUDA_ARCHITECTURES`.
  - Pinned to 3.8 because it's the last release that builds against Ubuntu
    22.04's Ceres 2.0; upgrading COLMAP also means building Ceres from source.
- **Image build**: the nerfstudio + CUDA image is the main technical risk.
  Iterate with `modal run gpu/splat_app.py` before `modal deploy`. Fallback is a
  hand-rolled COLMAP CLI + graphdeco-inria/gaussian-splatting path (noted in
  `splat_app.py`).
