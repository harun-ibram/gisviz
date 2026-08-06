# Splat ingestion pipeline

Turns user-uploaded photos into a Gaussian splat and a mesh, and attaches both
to a map feature. GPU work runs on **Modal** (serverless, scale-to-zero); the
FastAPI backend on Railway only orchestrates and writes to the database.

```
client            Railway (FastAPI)            Modal (GPU)               R2
  | POST /jobs ---------> create job row
  | <-- job_id + presigned PUT URLs
  | PUT photos --------------------------------------------------------> inputs/{job_id}/
  | POST /jobs/{id}/start -> spawn process() --> pull photos <---------- inputs/{job_id}/
  |                                              COLMAP + splatfacto
  |                                              upload scene ---------> models/{job_id}/scene.ply
  |                                              stage mesh inputs ----> work/{job_id}/
  |                          webhook <---------- POST (secret-signed)
  |                          set model_path, status=done
  | GET /jobs/{id} (poll) -> status
  |                       -> spawn mesh() ----> pull splat + bundle <--- models/ + work/
  |                                              SuGaR -> textured mesh
  |                                              upload mesh ----------> models/{job_id}/scene.glb
  |                          webhook <---------- POST (stage="mesh")
  |                          set mesh_path, mesh_status=done
  |                          delete inputs/{job_id}/ and work/{job_id}/
```

Neither worker touches the DB — they only read/write R2 and call the webhook,
which is what sets `model_path` / `mesh_path`.

**`status` is about the splat only.** It goes `done` as soon as the `.ply` is
stored, while the mesh is still 30-ish minutes away; the mesh stage reports
separately through `mesh_status`. A client that polls `status` and then loads
`model_path` behaves exactly as it did before SuGaR existed.

## Deploy

1. **Apply the schema** — the `public.jobs` table
   (`scripts/gis/schema.sql`) must exist in the Cloud SQL database.

2. **Create Modal secrets** (dashboard or `modal secret create`):
   - `gisviz-r2` → `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
   - `gisviz-webhook` → `JOB_WEBHOOK_SECRET`

3. **Deploy the GPU apps** (publishes the `gisviz-splat`/`process` and
   `gisviz-sugar`/`mesh` functions the backend looks up by name):
   ```
   modal deploy gpu/splat_app.py
   modal deploy gpu/sugar_app.py
   ```
   Two apps, two images, on purpose — see "Mesh extraction" below.

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
6. Optionally keep polling `mesh_status` (`processing` → `done` | `failed` |
   `skipped`) for the mesh. When it is `done`, `GET /nodes/{id}/model_path` and
   `GET /regions/{id}/model_path` also return `mesh_path` / `mesh_url` /
   `mesh_filename`, and the generic `/splat-url?path=` serves the `.glb` too.
   `POST /jobs/{job_id}/mesh` re-runs a `failed` mesh without re-uploading.

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

## Mesh extraction (SuGaR)

`gpu/sugar_app.py` runs [SuGaR](https://github.com/Anttwo/SuGaR) over the splat
that training already produced and stores a textured `.glb` next to it —
`models/{job_id}/old_town.ply` gets `models/{job_id}/old_town.glb`. Gaussian
splat training is untouched; SuGaR consumes its output.

**It is a separate Modal app with a separate image, deliberately.** The splat
image builds COLMAP from source (15–25 min) and pins nerfstudio; this one pins
torch 2.1.0 because that is the newest build PyTorch3D publishes a prebuilt
wheel for. Keeping them apart means a broken SuGaR layer can never take splat
training down with it, neither image is rebuilt when the other changes, and the
splat is servable ~30 minutes before the mesh is ready.

### The frame invariant

`splatfacto`'s exporter writes gaussian positions verbatim, so the `.ply` is in
**nerfstudio's** world frame — COLMAP coordinates already put through the
dataparser transform and scale — not COLMAP's. SuGaR reads camera poses from a
`cameras.json` in the 3DGS output directory rather than from COLMAP's sparse
model, so the splat worker writes that file from the *trained run's own
cameras*, in that same nerfstudio frame.

Two consequences:

- The splat never has to be transformed, which would mean rotating its spherical
  harmonics — the part everyone gets wrong.
- The mesh comes out in the frame the viewer already places the `.ply` in, so
  **mesh and splat coincide with no further work**. If a mesh ever loads rotated
  or mis-scaled against its splat, the OpenGL→OpenCV conversion in
  `_write_cameras_json` is the thing to look at, not SuGaR.

`dataparser_transforms.json` is staged alongside so a later step can map either
artifact into the ENU frame the georeferencing stage solves for.

### The checkpoint shim

nerfstudio produces nothing resembling an Inria 3DGS output directory, so
`mesh()` fabricates one: the exported `.ply` normalized to Inria's schema and
copied to `point_cloud/iteration_{7000,30000}/point_cloud.ply`, next to the
staged `cameras.json` and a token `cfg_args`.

The normalization is only about spherical harmonics. Inria's loader asserts
exactly 45 `f_rest_*` properties and reshapes them as (3 channels, 15
coefficients), so a splat exported at a lower SH degree is zero-padded **per
channel** — appending at the end would shift every coefficient into the wrong
channel. Positions, `opacity` (logit), `scale_*` (log) and `rot_*` (wxyz) are
stored identically by both and are copied straight across.

### Settings and cost

`--low_poly --refinement_time short -r dn_consistency` on an A10G: 200k
vertices, 2k refinement iterations, roughly 20–30 minutes, and a mesh a browser
can actually load. `--high_poly` with a `long` refinement is far better surface
detail at ~60–90 minutes and wants an A100 (its arch is already in the image's
`TORCH_CUDA_ARCH_LIST`). `--eval False` keeps every photo in training rather
than holding out every 8th — this is a capture pipeline, not a benchmark.

Note that SuGaR drives its stages through `os.system()` and does not check their
exit codes, so the subprocess returning 0 proves nothing. The glob for the
produced `.obj` is the real test, which is why a missing one raises.

### Retention

**The uploaded photos are deleted once the mesh succeeds** — both
`inputs/{job_id}/` and the `work/{job_id}/` handoff bundle, purged by the
backend in the mesh webhook. A *failed* mesh keeps them, so
`POST /jobs/{job_id}/mesh` can retry without asking for the upload again; once a
mesh succeeds that retry returns 409, and re-running the splat for that target
means re-uploading the photos.

`mesh_status = "skipped"` means the splat worker could not stage a bundle. That
is by design: staging happens after the `.ply` is already in R2 and its failure
is swallowed, because the worst outcome allowed there is a model without a mesh,
never a lost model.

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
