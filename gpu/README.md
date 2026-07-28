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

## Open items

- **Splat format**: the worker exports nerfstudio's `.ply` (3DGS). Confirm this
  matches what the frontend viewer loads (`.ply` vs `.splat`/`.ksplat`); adjust
  the `ns-export` step in `splat_app.py` if not.
- **Image build**: the nerfstudio + CUDA image is the main technical risk.
  Iterate with `modal run gpu/splat_app.py` before `modal deploy`. Fallback is a
  hand-rolled COLMAP CLI + graphdeco-inria/gaussian-splatting path (noted in
  `splat_app.py`).
