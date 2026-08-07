# SuGaR mesh extraction in the splat pipeline

> **Partly superseded by `OPTIONAL_MESH_PLAN.md`.** This plan makes the mesh
> unconditional; it is now opt-in per job via `want_mesh` on `POST /jobs`, and
> the retention rule below ("photos deleted only after the mesh succeeds")
> generalised to "deleted as soon as nothing left to run needs them" — which for
> a splat-only job is the splat webhook. Everything else here still describes
> the shipped pipeline.

## Context

Today `gpu/splat_app.py` turns uploaded photos into a Gaussian splat: COLMAP SfM →
optional EXIF-GPS georeferencing → `splatfacto-w-light` training → `.ply` export →
`models/{job_id}/{slug}.ply` in R2 → webhook sets `target.model_path`. The splat is
the only artifact, so anything that needs actual geometry (occlusion, measurement,
Blender export, physics) has nothing to work with. The uploaded photos under
`inputs/{job_id}/` are also never cleaned up — they sit in R2 forever.

This adds a second stage: run **SuGaR** (Anttwo/SuGaR) on top of the splat that
training already produced, upload the resulting textured mesh as a `.glb` next to
the `.ply`, and then purge the photos that were consumed. Gaussian splat training
is untouched — SuGaR consumes its output, it does not replace it.

Decisions taken: separate Modal app for SuGaR; GLB as the stored mesh; photos
deleted only after the mesh succeeds; `--low_poly` + `dn_consistency` quality preset.

---

## The two things that make this non-trivial

**1. Coordinate frame.** `splatfacto-w`'s `export_script.py` writes `model.means`
verbatim — the gaussians are in **nerfstudio world frame**, i.e. COLMAP coordinates
already put through `dataparser_transform` (auto-orient + centre, with
`applied_transform` composed in) and `dataparser_scale`. SuGaR's `load_gs_cameras`
(`sugar_scene/cameras.py`) reads camera poses from `cameras.json` in the 3DGS output
directory, *not* from `sparse/0` — so we are free to hand it cameras in whatever
frame we like. Handing it **nerfstudio-frame cameras** means the gaussians never
have to be transformed (which would require rotating SH bands — the messy part), and
the mesh comes out in the *same frame as the `.ply` the viewer already loads, so mesh
and splat overlay exactly with zero further work*. `dataparser_transforms.json` is
carried along as metadata so a later step can map either artifact into the ENU frame
the georeferencing stage computes.

**2. Checkpoint shim.** SuGaR loads gaussians from
`{gs_output_dir}/point_cloud/iteration_{N}/point_cloud.ply` and cameras from
`{gs_output_dir}/cameras.json`; images from `{scene_path}/images/{img_name}{ext}`.
None of that exists in nerfstudio's output layout, so the mesh worker fabricates a
minimal Inria-3DGS-shaped directory around the exported `.ply`.

---

## Architecture

```
Modal gisviz-splat.process        Railway (FastAPI)          Modal gisviz-sugar.mesh
  COLMAP + splatfacto
  export splat.ply ------------------------------------> models/{job_id}/{slug}.ply
  stage handoff bundle ----------------------------------> work/{job_id}/
  webhook {stage:"splat", work_prefix} --> set model_path, status=done
                                       --> spawn mesh() ------> pull ply + bundle
                                                                 SuGaR coarse+mesh+refine
                                                                 OBJ+MTL+PNG -> GLB
                                       <-- webhook {stage:"mesh", mesh_key}
                                       set mesh_path, mesh_status=done
                                       r2_delete_prefix(inputs/{job_id}/)
                                       r2_delete_prefix(work/{job_id}/)
```

The backend stays the only component that touches the database; both workers only
read/write R2 and post secret-signed webhooks — same contract as today.

---

## Changes

### 1. `gpu/splat_app.py` — stage a handoff bundle (splat path otherwise unchanged)

New `_stage_mesh_inputs(client, config_path, processed_dir, work_prefix) -> dict`,
called after the `.ply` upload at line 427, wrapped in `try/except` that logs and
returns `None` — **a staging failure must never fail a splat that already uploaded**.

- Load the trained run with `from nerfstudio.utils.eval_utils import eval_setup`;
  `eval_setup(Path(config_path), test_mode="inference")` gives
  `pipeline.datamanager.train_dataset` with `.cameras` and `.image_filenames`. This is
  the authoritative source: it already reflects nerfstudio's auto downscale choice
  (`images_2/`, `images_4/`…), so widths/heights and the image directory always match.
  *Fallback if `eval_setup` proves awkward:* compute the same values with numpy from
  `processed/transforms.json` + `outputs/**/dataparser_transforms.json`.
- Write `cameras.json` in Inria format, one entry per training camera:
  `{"id", "img_name", "width", "height", "position", "rotation", "fx", "fy"}` where
  `position = camera_to_worlds[:3, 3]` and
  `rotation = camera_to_worlds[:3, :3] @ diag(1, -1, -1)` — nerfstudio cameras are
  OpenGL (x right, y **up**, z back), Inria's `camera_to_JSON` stores an OpenCV
  camera-to-world rotation. `img_name` is the image filename **stem**, because SuGaR
  reassembles it as `os.path.join(image_dir, name + extension)`.
- Upload to `work/{job_id}/`: `cameras.json`, `dataparser_transforms.json` (copied
  from the nerfstudio run dir), and every file in `train_dataset.image_filenames[i].parent`
  under `work/{job_id}/images/`. The exported `.ply` is **not** re-uploaded — the mesh
  worker pulls it from `output_key`.
- Return `{"work_prefix": f"work/{job_id}/"}` and merge it into the existing webhook
  payload at line 428.

No other change to `process()`; timeout, GPU and image stay as they are.

### 2. `gpu/sugar_app.py` — new Modal app `gisviz-sugar`

Image (separate from the splat image on purpose: the COLMAP/nerfstudio image takes
15–25 min to rebuild and is described in its own comments as the main technical risk —
a broken SuGaR layer must never be able to take splat training down with it):

- `nvidia/cuda:11.8.0-devel-ubuntu22.04`, `add_python="3.10"`.
- apt: `git build-essential cmake ninja-build pkg-config libgl1 libglib2.0-0 libegl1 libglvnd-dev`.
- env: `TORCH_CUDA_ARCH_LIST="7.5;8.0;8.6"`, `FORCE_CUDA=1`, `CC=gcc`, `CXX=g++`
  (same reason as the splat image: `add_python`'s interpreter reports clang).
- **`torch==2.1.0` / `torchvision==0.16.0` cu118, pinned deliberately** — that is the
  newest combination with a prebuilt PyTorch3D wheel
  (`https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu118_pyt210/download.html`).
  Building PyTorch3D from source adds 30+ min to every image rebuild.
- pip: `open3d PyMCubes plyfile==0.8.1 rich plotly trimesh pillow boto3 requests "numpy<2"`
  (numpy 2 breaks open3d and the pytorch3d wheel).
- `git clone --recursive https://github.com/Anttwo/SuGaR.git /opt/sugar`, then
  `pip install -e` on `gaussian_splatting/submodules/diff-gaussian-rasterization` and
  `.../simple-knn`, then nvdiffrast from `NVlabs/nvdiffrast`.
- Build assertion mirroring the existing COLMAP one:
  `python -c "import pytorch3d, diff_gaussian_rasterization, simple_knn, open3d, trimesh"`.

`mesh(job_id, splat_key, work_prefix, mesh_key, webhook_url)` — `gpu="A10G"`,
`timeout=5400`, same two secrets as `process()`:

1. Download `splat_key` and `work_prefix` into a temp work dir.
2. **Normalize the PLY to Inria's schema** (`_to_inria_ply`, plyfile + numpy).
   SuGaR's `GaussianModel.load_ply` asserts exactly `3*(sh_degree+1)**2 - 3 == 45`
   `f_rest_*` properties; zero-pad or truncate to 45 if `splatfacto-w-light` exports a
   different SH degree. `opacity` (logit) and `scale_*` (log) and `rot_*` (wxyz) already
   match nerfstudio's storage convention — no conversion there.
3. Build the shim tree:
   `scene/{job_id}/images/` ← staged images; `gs/cameras.json` ← staged;
   `gs/point_cloud/iteration_7000/point_cloud.ply` **and** `iteration_30000/point_cloud.ply`
   ← the normalized PLY (write both: `train.py`'s `--iteration_to_load` defaults differ
   from the wrapper's `iteration_to_load=30000`); a minimal `gs/cfg_args` for safety.
4. Run, with `cwd="/opt/sugar"` (SuGaR writes to `./output` relative to CWD):
   ```
   python train_full_pipeline.py \
     -s {work}/scene/{job_id} --gs_output_dir {work}/gs \
     -r dn_consistency --low_poly True --refinement_time short \
     --export_obj True --export_ply False --eval False --white_background False
   ```
   Scene name = last path component, so outputs land deterministically under
   `/opt/sugar/output/refined_mesh/{job_id}/`; still locate the `.obj` by glob and raise
   `RuntimeError` when empty, matching how `process()` handles `config.yml`/`.ply`.
5. `trimesh.load(obj)` → `.export(glb)`; upload with
   `ExtraArgs={"ContentType": "model/gltf-binary"}` to `mesh_key`.
6. Webhook `{"stage": "mesh", "status": "done", "mesh_key": ..., "vertices": n, "faces": n}`;
   on exception, `{"stage": "mesh", "status": "failed", "error": str(exc)}` then re-raise —
   copy `_post_webhook` and `_download_prefix`/`_r2_client` from `gpu/splat_app.py`
   (they are 15 lines each and duplicating keeps the two images independent, which is
   the whole point of splitting them).

### 3. `src/models.py` + `scripts/gis/schema.sql`

`Job` gains: `work_prefix`, `mesh_key`, `mesh_status` (`pending|processing|done|failed`),
`mesh_error`, `mesh_call_id`, `inputs_deleted_at`. `OSMNode` and `Region` gain
`mesh_path: str | None` mirroring the existing `model_path` column.

Existing `status` keeps its exact meaning — `done` still means *the splat is ready* —
so `Upload.jsx`'s `pollUntilDone` keeps working untouched while the mesh cooks. Write
the DDL as `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, following the idempotent-DDL style
already used for `public.regions` in `schema.sql`.

### 4. `src/main.py`

- `WebhookRequest` gains `stage: str = "splat"`, `work_prefix`, `mesh_key`.
- `job_webhook`: branch on `stage`. The `"splat"` branch is today's code plus storing
  `work_prefix` and, when both `work_prefix` and `output_key` are present, spawning the
  mesh job (`modal.Function.from_name("gisviz-sugar", "mesh").spawn(...)` with
  `mesh_key = f"models/{job_id}/{slug}.glb"` — same `slugify` + directory as the `.ply`,
  which is what "next to the gaussian model" means) and setting `mesh_status="processing"`.
  No `work_prefix` → `mesh_status="skipped"`, splat still completes normally.
  The `"mesh"` branch sets `target.mesh_path`, `job.mesh_key`, `mesh_status="done"`, then
  **purges** `inputs/{job_id}/` and `work/{job_id}/` via `r2_delete_prefix` (already exists
  in `src/gis_runtime.py:488`, best-effort and batched) and stamps `inputs_deleted_at`.
  On mesh failure: record `mesh_error`, **keep the photos** so the run can be retried.
- `GET /jobs/{job_id}`: add `mesh_status`, `mesh_key`, `mesh_error`.
- `GET /nodes/{id}/model_path` and `GET /regions/{id}/model_path`: add `mesh_path` and a
  `mesh_url` (`get_signed_url`) when set — no new endpoint needed, and the generic
  `GET /splat-url?path=` at line 88 already serves the GLB.
- New `POST /jobs/{job_id}/mesh` (`dependencies=[RequireUser]`): re-spawn `mesh()` for a
  job whose `mesh_status` is `failed`. 409 if the photos were already purged.

### 5. `gpu/README.md`

Extend the flow diagram with the mesh leg, document the `gisviz-sugar` deploy
(`modal deploy gpu/sugar_app.py`, reuses the same two secrets), the new webhook `stage`
field, the frame invariant from the top of this document, and the retention rule
(photos deleted on mesh success only).

---

## Risks worth naming up front

- **nvdiffrast in a headless container.** Its OpenGL backend needs EGL; if
  `RasterizeGLContext` fails, force SuGaR onto `RasterizeCudaContext` or fall back to
  `--export_obj False` and mesh-only output (no texture). Verify during the first
  `modal run`, not after deploy.
- **`f_rest` count mismatch** is the single most likely hard failure. Print the actual
  property count in `_to_inria_ply` so the log says why.
- **SuGaR licence** is non-commercial (inherited from Inria 3DGS). Fine for this project
  as it stands; worth knowing before any commercial deployment.
- Photos are gone after a successful mesh — a *splat* re-run for the same target then
  requires re-uploading. Called out in the README.

---

## Verification

1. `modal run gpu/sugar_app.py` against a hand-staged bundle in R2 (take a `work/` prefix
   from a real splat job) before ever calling `modal deploy` — this is where the image
   and the nvdiffrast question get settled. Expect ~20–30 min per iteration on an A10G.
2. `modal deploy gpu/splat_app.py && modal deploy gpu/sugar_app.py`.
3. Apply the `ALTER TABLE` statements to Cloud SQL.
4. Backend endpoints locally with the throwaway-Postgres setup (stubbed `deps.py`, local
   PG16 cluster): `POST /jobs` → PUT photos → `POST /jobs/{id}/start`, then poll
   `GET /jobs/{id}` and assert the sequence
   `status: processing → done` while `mesh_status: processing → done`.
5. End-to-end assertions on a real 30–60 photo set:
   - `models/{job_id}/{slug}.ply` and `models/{job_id}/{slug}.glb` both exist in R2.
   - `inputs/{job_id}/` and `work/{job_id}/` both list zero objects afterwards.
   - The target row has both `model_path` and `mesh_path` set.
   - Load the GLB and the PLY in the viewer together: **they must coincide** — that is
     the check that the frame reasoning above is right. If the mesh is rotated or
     mis-scaled relative to the splat, the `cameras.json` conversion (OpenGL→OpenCV) is
     wrong, not SuGaR.
6. Failure paths: point `mesh()` at a bogus `splat_key` and confirm
   `mesh_status="failed"`, `status` still `"done"`, and `inputs/{job_id}/` **untouched**;
   then confirm `POST /jobs/{id}/mesh` recovers it.
