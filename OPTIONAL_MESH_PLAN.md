# Optional mesh stage — backend plan

## Context

Every photo upload today runs two GPU stages: the splat (`gisviz-splat`, ~1h cap)
and then SuGaR (`gisviz-sugar`, ~1.5h cap), chained unconditionally in
`_handle_splat_result` (`src/main.py:394`). Most uploads only need the Gaussian
splat, so users wait roughly twice as long as necessary and pay for a mesh they
never look at.

The change: make the mesh **opt-in at upload time** (`POST /jobs`), warn the user
that ticking it roughly doubles processing time, and let the splat-only path
release storage as soon as the splat is done. Retention today is "purge the
photos once the mesh succeeds" (`_handle_mesh_result`, `src/main.py:427`); with
the mesh optional, the rule becomes **purge as soon as nothing left to run needs
the photos** — right after the splat when no mesh was asked for, after the mesh
otherwise.

Decisions already made: the flag defaults to **`False`** (a caller that doesn't
send it gets a splat only), and the purge for the no-mesh path runs in the
**backend webhook handler**, reusing `r2_delete_prefix`, not inside the Modal
worker.

Scope is the backend + the two GPU workers in `gpu/`. The frontend checkbox and
warning copy live on the `frontend` branch and are out of scope here; the API
contract they need is spelled out at the end.

## Changes

### 1. `public.jobs.want_mesh` column

Follow the established three-file pattern (no Alembic in this repo — idempotent
DDL applied at boot):

- **`src/models.py`** (`Job`, line 245): add next to `work_prefix`
  ```python
  # Whether the user asked for a SuGaR mesh on top of the splat. False means
  # the photos are purged as soon as the splat lands — nothing else reads them.
  want_mesh: bool = Field(
      default=False, sa_column=Column("want_mesh", Boolean, nullable=False, server_default=text("false"))
  )
  ```
  (`Boolean` needs adding to the `sqlalchemy` import at the top of the file.)
- **`src/gis_schema.py`** `DDL_STATEMENTS`, in the existing "6. splat pipeline"
  block (line ~153):
  ```python
  "ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS want_mesh BOOLEAN NOT NULL DEFAULT FALSE",
  ```
- **`scripts/gis/schema.sql`** `CREATE TABLE public.jobs` (line 119): add the
  column with a comment, keeping the file in sync with the model.

Caveat to accept knowingly: existing rows — including any job that is
*mid-splat* when this deploys — backfill to `false`, so their webhook lands on
the no-mesh path (mesh skipped, photos purged). Given the queue drains in about
an hour, deploying when nothing is in flight avoids it entirely; no backfill
`UPDATE` is worth writing for it.

### 2. Accept and store the flag — `src/main.py`

- `CreateJobRequest` (line 259): `want_mesh: bool = False` with a comment stating
  the default is opt-out-by-omission and why.
- `create_job` (line 278): pass `want_mesh=body.want_mesh` into the `Job(...)`
  constructor.
- `get_job` (line 354): add `"want_mesh": job.want_mesh` to the response dict so
  the UI can distinguish "mesh not requested" from "mesh unavailable" — both
  surface as `mesh_status="skipped"`.

### 3. Pass it to the worker — `start_job` (`src/main.py:322`)

```python
call = process.spawn(job.id, job.input_prefix, output_key, webhook_url, job.want_mesh)
```

### 4. Skip staging in the splat worker — `gpu/splat_app.py`

`_stage_mesh_inputs` (line 404) re-uploads every training image plus
`cameras.json` to `work/{job_id}/`; that is pure waste when no mesh follows.

- Signature (line 456): `def process(job_id, input_prefix, output_key, webhook_url, want_mesh: bool = False) -> None:`
  — keep the default so a backend that spawns with four positional args (an
  older deploy, a manual `modal run`) still works.
- Wrap step 5 (line 528-539): only call `_stage_mesh_inputs` when `want_mesh`;
  otherwise `mesh_inputs = {}` and print a line saying staging was skipped
  because no mesh was requested. The webhook payload shape is unchanged — the
  backend already treats a missing `work_prefix` as "nothing to mesh".

Nothing else in `gpu/` changes; `gpu/sugar_app.py` is simply never spawned for
these jobs.

### 5. Retention branch — `_handle_splat_result` (`src/main.py:394`)

After `job.status = "done"`, before the existing `work_prefix` handling:

```python
if not job.want_mesh:
    # No second stage will read the photos, so release them now rather than
    # waiting on a mesh that was never requested.
    job.mesh_status = "skipped"
    job.mesh_error = None          # not a failure: nobody asked for a mesh
    _purge_inputs(job)
    return
```

Keep the existing `if not body.work_prefix: mesh_status = "skipped"` branch for
the *requested-but-staging-failed* case (its `mesh_error` message is what tells
the two apart), and have it purge too — that job can never be meshed
(`POST /jobs/{id}/mesh` requires `work_prefix`), so leaving its photos behind
leaks them forever. This is the one behaviour change beyond the feature itself;
it is the same rule ("purge when nothing left can use them") applied
consistently.

Factor the purge out of `_handle_mesh_result` (line 445-452) into a small helper
so all three call sites share it and the `inputs_deleted_at` stamp stays
consistent:

```python
def _purge_inputs(job: Job) -> None:
    """Drop the photos and any staged bundle. Best-effort: never raises."""
    deleted = r2_delete_prefix(job.input_prefix)
    if job.work_prefix:
        deleted += r2_delete_prefix(job.work_prefix)
    job.inputs_deleted_at = datetime.now(timezone.utc)
    logger.info("Job %s: purged %d source object(s)", job.id, deleted)
```

`r2_delete_prefix` (`src/gis_runtime.py:496`) already swallows S3 errors, which
is why this can run after the DB fields are set without risking the result.

Unchanged: a **failed** mesh keeps the photos so `POST /jobs/{id}/mesh` can
retry.

### 6. Retry endpoint message — `retry_mesh_job` (`src/main.py:486`)

The existing `inputs_deleted_at` guard (line 500) already 409s a splat-only job,
but the message "This job's inputs were already purged" is misleading there. Add
an earlier, explicit check:

```python
if not job.want_mesh:
    raise HTTPException(
        status_code=409,
        detail="No mesh was requested for this job; its photos were purged after the splat.",
    )
```

Deliberately **not** offering "turn the mesh on after the fact": the photos and
the handoff bundle are gone by then, so the only honest answer is a re-upload.

### 7. Docs

- `gpu/README.md` "Retention" section (line ~168): rewrite to the new rule and
  document the two distinct meanings of `mesh_status="skipped"` (`want_mesh`
  false → not requested; `want_mesh` true → staging failed).
- `SUGAR_PLAN.md` retention notes (lines ~10-18, 58-59, 173-175): add a short
  "superseded by the optional-mesh change" note rather than rewriting history.
- This file (`OPTIONAL_MESH_PLAN.md`) lives on the `optional_mesh_backend`
  branch, per the repo convention that a plan travels with the branch that
  implements it. The frontend half belongs in `OPTIONAL_MESH_PLAN_FRONTEND.md`
  on the frontend branch.

## Deploy order

1. `modal deploy gpu/splat_app.py` — the new `want_mesh` parameter defaults to
   `False`, so the currently-deployed backend (4 positional args) keeps working.
2. Backend to Railway. `ensure_gis_schema` adds the column at boot (`GIS_AUTO_MIGRATE`
   must not be `"0"`).
3. Frontend last — until it ships, every upload is splat-only, which is the
   intended default.

## Frontend contract (separate branch)

- `POST /jobs` body gains `want_mesh: boolean`. Checkbox unticked by default,
  labelled something like *"Also build a 3D mesh — roughly doubles processing
  time (about 1h extra)."*
- `GET /jobs/{id}` gains `want_mesh`; render `mesh_status="skipped"` as
  "not requested" when `want_mesh` is false and as "unavailable" when it is true.
- Don't offer the "retry mesh" action for jobs with `want_mesh: false` — it 409s.

## Verification

No test suite exists in the repo, so this is a manual pass plus a local route
check.

1. **Local routes** (per the dev-box constraints: no Docker/PostGIS/R2 creds) —
   stub `deps.py` earlier on `sys.path` than `src/`, exporting `engine`,
   `SessionDep`, `get_session`, `BUCKET`, `r2_client`, `get_signed_url`,
   `get_upload_url`, backed by a throwaway PG16 cluster from
   `/usr/lib/postgresql/16/bin` (`initdb` + `pg_ctl -k $(mktemp -d /tmp/pgsock.XXXX)`).
   Run with `backend/bin/python`. Then with `TestClient`:
   - `POST /jobs` without `want_mesh` → row has `want_mesh = false`;
     with `want_mesh: true` → `true`. `GET /jobs/{id}` echoes it.
   - Monkeypatch `r2_delete_prefix` to a counter and POST the splat webhook
     (`X-Webhook-Secret`, `status: "done"`, no `work_prefix`) for a
     `want_mesh=false` job → `mesh_status="skipped"`, `mesh_error` null,
     `inputs_deleted_at` set, purge called once.
   - Same for a `want_mesh=true` job with a `work_prefix`, monkeypatching
     `_spawn_mesh_job` → mesh spawned, `inputs_deleted_at` still null.
   - `POST /jobs/{id}/mesh` on a `want_mesh=false` job → 409 with the new detail.
2. **DDL idempotence**: boot the app twice against the throwaway cluster; the
   `ADD COLUMN IF NOT EXISTS` must not warn on the second run. Note that
   `ensure_gis_schema` only logs statement failures, so check the logs rather
   than trusting a clean start.
3. **End-to-end, small capture (~20 photos), `want_mesh: false`**: total wall
   time should be the splat alone; Modal logs show the "skipping mesh staging"
   line; `work/{job_id}/` is never created; `inputs/{job_id}/` is empty in R2
   right after the job reports `done`; `model_path` set, `mesh_path` null.
4. **Same capture, `want_mesh: true`**: unchanged from today — `work/{job_id}/`
   populated, `gisviz-sugar` spawned, both prefixes purged only after
   `mesh_status="done"`, `mesh_path` set.
