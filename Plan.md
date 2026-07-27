# Architecture: In-app photos → COLMAP → Gaussian splat pipeline

## Context

The splat *display* path is already complete: `model_path` on `osm.nodes` / `public.regions`
holds an R2 object key, served via `/splat-url` (presigned GET) to a frontend viewer that lives
in a separate repo/branch not present in this checkout. What's missing is **ingestion**: turning
user-uploaded photos into a splat automatically. That needs GPU compute (COLMAP + Gaussian
Splatting training) that the Railway-hosted FastAPI backend can't provide (no GPU, no
multi-minute request budget). GPU work must be offloaded to an external provider, triggered by
the backend, writing the result back to R2 + `model_path`.

Goal: cheapest viable path for **rare/experimental** volume, fully automated end-to-end.

This session confirmed via `git ls-files` that this checkout has **no frontend code** (no
.jsx/.tsx, no package.json) and **no tracked/present secrets** (`key.json`/`.env` don't exist
here and are already git-ignored) — so this plan drops the security-fix item from the original
draft and treats the frontend as out of scope, exposing only the API contract it would call.

## Decision: run GPU work on Modal (serverless)

Scale-to-zero + per-second billing means $0 idle cost, and the $30/month free credit likely
covers all experimental usage (~$0.35–1.10/scene on an A10G). Python-native function, no
Dockerfile needed to get started — `Function.lookup(...).spawn(...)` from FastAPI. Revisit
RunPod/Vast.ai only if volume becomes sustained/daily.

## Target architecture

```
Frontend (out of scope)        Railway (FastAPI)              Modal (GPU, scale-to-zero)     R2
   |  1. POST /jobs  ------------------>  create job row
   |  <-- job_id + presigned PUT URLs
   |  2. PUT photos ----------------------------------------------------------------------->  inputs/{job_id}/
   |  3. POST /jobs/{id}/start ------->  Function.spawn() ---->  pull photos <----------------- inputs/{job_id}/
   |                                                             ns-process-data (COLMAP)
   |                                                             ns-train splatfacto
   |                                                             ns-export gaussian-splat -> .ply
   |                                                             upload scene ---------------->  models/{job_id}/scene.ply
   |                                     webhook  <------------  POST result (secret-signed)
   |                                     set model_path + status=done
   |  4. GET /jobs/{id} (poll) ------>  status
   |  5. splat renders via existing /splat_nodes + /splat-url (no change)
```

The GPU worker never touches the DB — only R2 creds + a webhook secret. All DB writes stay in
FastAPI, which already holds Cloud SQL creds.

## What to build

### 1. Job model + table
Add to `src/models.py` a SQLModel `Job` (`__tablename__ = "jobs"`, `__table_args__ = {"schema":
"public"}`), following the existing table style (e.g. `Region` at `src/models.py:100`):
`id: str` (uuid, primary key), `status: str` (`pending|processing|done|failed`), `target_type:
str` (`node`|`region`), `target_id: str`, `input_prefix: str`, `output_key: str | None`,
`modal_call_id: str | None`, `error: str | None`, `created_at`/`updated_at` (`DateTime(timezone=True)`,
matching the `timestamp` column pattern at `src/models.py:28-30`).

This project has no migration framework — tables are defined directly as SQL DDL in
`scripts/gis/schema.sql` (see `CREATE TABLE public.regions` at line 95) and presumably applied
by hand/via `load_gis.py`. Add a matching `CREATE TABLE public.jobs (...)` block there so the
DDL and the SQLModel stay in sync, same as `regions`/`nodes` already do.

### 2. Backend write endpoints
Both `src/main.py` and `src/server/main.py` currently only expose GETs and are near-duplicates
(the top-level one additionally wires GCP/R2 client setup and `/splat-url`; `src/server/main.py`
imports `get_session` from `src/database.py` instead). Add the following to **both**, mirroring
whichever already has the more complete pattern in `src/main.py`:

- `POST /jobs` — body: `{target_type, target_id, filenames: [str]}`. Insert a `Job` row
  (`status="pending"`, `input_prefix=f"inputs/{job_id}/"`). For each filename, generate a
  presigned **PUT** URL with `r2_client.generate_presigned_url("put_object", ...)` — the same
  client already configured at `src/main.py:34-41`, just a new method call alongside the existing
  `get_signed_url` (`get_object`) helper. Return `{job_id, upload_urls: {filename: url}}`.
- `POST /jobs/{id}/start` — look up the job, call
  `modal.Function.lookup("gisviz-splat", "process").spawn(job_id, input_prefix, output_key,
  webhook_url)`, store the returned call id, set `status="processing"`.
- `GET /jobs/{id}` — return job status/error for polling.
- `POST /jobs/{id}/webhook` — verify a shared-secret header (`X-Webhook-Secret` against
  `JOB_WEBHOOK_SECRET` env var) before trusting the body. On success: set `model_path =
  output_key` on the target `OSMNode`/`Region` row (whichever `target_type` says) and
  `status="done"`. On failure payload: `status="failed"`, store `error`.

### 3. Modal app (`gpu/splat_app.py`, new)
- `modal.Image` from a CUDA base (e.g. `nvidia/cuda:11.8.0-devel-ubuntu22.04`) installing
  **COLMAP** (apt or conda-forge) and **nerfstudio** (`pip install nerfstudio`), which bundles
  `splatfacto` (Gaussian Splatting) training and wraps COLMAP internally via `ns-process-data
  images`. Use nerfstudio as the primary path per your direction; if the CUDA/dependency build
  proves unworkable inside a Modal image, fall back to a hand-rolled COLMAP CLI
  (feature_extractor → exhaustive_matcher → mapper) plus `graphdeco-inria/gaussian-splatting`'s
  training script (`train.py`) with its `diff-gaussian-rasterization`/`simple-knn` submodules —
  note this fallback in a code comment so the choice is visible later.
- `@app.function(gpu="A10G", timeout=1800, secrets=[...])` `process(job_id, input_prefix,
  output_key, webhook_url)`:
  1. Download photos from R2 (`input_prefix`) into a local `images/` dir.
  2. `ns-process-data images --data images/ --output-dir processed/` (runs COLMAP under the hood,
     produces `transforms.json` + sparse point cloud).
  3. `ns-train splatfacto --data processed/ --output-dir outputs/` (or whatever nerfstudio's
     current non-interactive/headless flags are — verify with `ns-train splatfacto --help`
     during `modal run` iteration; may need `--viewer.quit-on-train-completion True`).
  4. `ns-export gaussian-splat --load-config outputs/.../config.yml --output-dir export/` to
     produce a `.ply` (nerfstudio's standard 3DGS export format — flag this as the item to
     confirm against whatever the frontend viewer loads, since that code isn't visible here).
  5. Upload the exported `.ply` to `models/{job_id}/scene.ply` in R2.
  6. POST to `webhook_url` with the webhook secret header, `{job_id, output_key, status}` (or
     `status="failed", error` on exception — wrap steps 2-5 in try/except so a webhook always
     fires and the job doesn't hang in `processing` forever).
- R2 creds + webhook secret injected via `modal.Secret.from_name(...)`. GPU: A10G default; T4 for
  small scenes to cut cost; A100 only if OOM/time-limited.

### 4. Deploy glue
- Add `modal` (and `nerfstudio` if training is also exercised outside Modal) to
  `src/requirements.txt`.
- Set `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`/`JOB_WEBHOOK_SECRET` in the Railway dashboard
  (outside this session's reach — document as a manual step).
- `modal deploy gpu/splat_app.py` publishes the function separately from the Railway deploy.

### 5. Frontend — API contract only (no code here)
Document (in a short README or docstring near the new endpoints) the call sequence a frontend
would follow: `POST /jobs` → PUT each file to its presigned URL → `POST /jobs/{id}/start` → poll
`GET /jobs/{id}` until `done`/`failed` → on `done`, the existing `/splat_nodes`/`/splat-url` path
picks up the new `model_path` with no viewer changes needed. Confirming the exact splat file
format the viewer expects (`.ply` vs `.splat`/`.ksplat`) is an explicit open item since that repo
isn't visible from here.

## Verification (end-to-end)
1. `modal run gpu/splat_app.py` against a small local photo set → confirm a `.ply` lands in R2
   under `models/…`.
2. Run FastAPI locally against the dev PostGIS (`docker-compose.yaml`, port 5433 per existing
   setup): apply the new `jobs` DDL, then `POST /jobs` → PUT photos to returned URLs → `POST
   /jobs/{id}/start` → poll `GET /jobs/{id}` to `done` → confirm `model_path` is set on the
   target row.
3. Check Modal dashboard: job billed only for active seconds, worker idles to zero afterward.
4. (Once a frontend session is available) load the map and confirm the new node/region renders
   through the existing `/splat_nodes` + `/splat-url` + viewer path.

## Open items to confirm during implementation
- Exact splat format the (separate, unseen) frontend viewer expects — drives step 4 of the Modal worker's export.
- Whether nerfstudio's CUDA build actually fits cleanly in a Modal image (main technical risk);
  fallback is the hand-rolled COLMAP + graphdeco-inria/gaussian-splatting path noted above.
- Which map feature a photo set targets in practice — `node`, `region`, or a new feature type.