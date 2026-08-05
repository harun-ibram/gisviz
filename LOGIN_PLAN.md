# Login Plan — Backend

Gate the upload/write endpoints behind a login while keeping every viewing tab
public. This document covers the **backend** only (branch `login`); the frontend
plan is written separately.

## Context

The API on this branch is fully open. Anyone who knows the Railway URL can create
splat jobs, create GIS jobs, occupy the single worker slot, fill the R2 bucket, and
delete layers — `src/gis_api.py:42-54` has an `X-API-Key` guard that is a no-op
because `GIS_API_KEY` is unset by default, and `src/main.py` has no guard at all on
its mutating routes.

We want a simple login system: **only logged-in users can upload**, while **everyone
can still view every tab** (nodes, regions, splats, GIS layers, buildings, jobs list).
So all `GET` routes stay public and only the write/upload/delete routes get gated.

Decisions already made:

- **JWT bearer tokens** — `POST /auth/login` returns a signed token; the frontend
  sends `Authorization: Bearer <token>`. Stateless, no session table, and no CORS
  credential changes (`allow_headers=["*"]` at `src/main.py:64` already permits the
  header).
- **No public signup** — accounts are created with a small CLI script run against
  the database.
- **No ownership tracking** — any logged-in user may upload, start, and delete. No
  new columns on `gis_jobs` / `jobs`.

## What gets protected

| Protected (needs a valid token) | Stays public |
|---|---|
| `POST /nodes` (`main.py:136`) | every `GET` in `main.py` and `gis_api.py` |
| `POST /regions` (`main.py:165`) | `GET /gis/config`, `/gis/jobs`, `/gis/layers`, `/gis/buildings`, `/gis/asset-url` |
| `POST /jobs` (`main.py:241`) | `GET /splat-url`, `/nodes*`, `/regions*`, `/jobs/{id}` |
| `POST /jobs/{job_id}/start` (`main.py:277`) | `POST /jobs/{job_id}/webhook` (`main.py:324`) — keeps its own `X-Webhook-Secret`; Modal has no user |
| `POST /gis/jobs` (`gis_api.py:435`) | |
| `POST /gis/jobs/{job_id}/start` (`gis_api.py:498`) | |
| `DELETE /gis/jobs/{job_id}` (`gis_api.py:603`) | |
| `DELETE /gis/layers/{layer_id}` (`gis_api.py:776`) | |

## Files

### New: `src/auth.py` — core (no router, so `gis_api` can import it without a cycle)

Mirrors the `gis_runtime` / `gis_schema` / `gis_api` split already in `src/`.
Uses raw `text()` SQL against `deps.engine`, like `gis_api.py` does — no new
SQLModel in `models.py`.

- `AUTH_DDL: list[str]` + `ensure_auth_schema(engine)` — same one-statement-per-
  transaction shape as `ensure_gis_schema` (`src/gis_schema.py:156`), required
  because pg8000 cannot batch `;`-separated statements:

  ```sql
  CREATE TABLE IF NOT EXISTS public.users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,   -- stored lowercased
      password_hash TEXT NOT NULL,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )
  ```

- `hash_password(pw)` / `verify_password(pw, hash)` — `bcrypt` directly (not
  passlib). Reject passwords over 72 bytes at the call site, since bcrypt silently
  truncates there.
- `create_access_token(user)` / `decode_token(tok)` — PyJWT, HS256, claims
  `sub` (user id), `email`, `iat`, `exp`.
- Config read from env at import: `AUTH_SECRET` (no default), `AUTH_TOKEN_TTL`
  (seconds, default `28800` = 8h). If `AUTH_SECRET` is unset the module logs a
  warning and **fails closed**: login returns 503, every protected route returns
  401. Deliberately not `os.environ[...]` like `deps.py:30` — a missing auth
  secret must not stop the public viewing API from booting.
- `get_current_user(...)` FastAPI dependency using `HTTPBearer(auto_error=False)`:
  401 on missing/malformed/expired token, 401 if the user row is gone or
  `is_active` is false. Returns a small `AuthUser` pydantic model (`id`, `email`).
  Export `RequireUser = Depends(get_current_user)` for use as
  `dependencies=[RequireUser]`.
- Light brute-force brake: in-memory `{email: (fail_count, first_fail_ts)}`, 5
  failures per 15 min → 429. Single Railway instance, so a dict is enough; note in
  a comment that it resets on redeploy and is per-process.

### New: `src/auth_api.py` — `APIRouter(prefix="/auth", tags=["auth"])`

- `POST /auth/login` — body `{email, password}`. Lowercases email, looks the user
  up, `verify_password`, always burns the same bcrypt work on a missing user
  (compare against a fixed dummy hash) so response time doesn't leak whether an
  account exists. Returns
  `{"access_token": ..., "token_type": "bearer", "expires_in": <ttl>, "user": {"id":..., "email":...}}`.
  401 with a single generic "Invalid email or password" for both failure modes.
- `GET /auth/me` — takes `user: AuthUser = RequireUser`, returns `{id, email}`. The
  frontend uses this to decide whether to show the upload UI on page load and to
  detect an expired token.
- No logout endpoint — with stateless JWTs the client just drops the token.

### New: `src/create_user.py` — account creation CLI

`python src/create_user.py <email> [--password X]`; prompts via `getpass` when
`--password` is omitted so the password never lands in shell history. Calls
`ensure_auth_schema(engine)` first, then upserts
(`ON CONFLICT (email) DO UPDATE SET password_hash = ...`) so it doubles as a
password reset. Add `--deactivate` to flip `is_active` off. Needs the same env
vars `deps.py` needs (Cloud SQL + R2), because importing `deps` builds both
clients — document that in the module docstring.

### Modified: `src/main.py`

- Import `ensure_auth_schema` and call it in `lifespan` (`main.py:33-54`) inside
  its own `try/except`, next to the existing `ensure_gis_schema` call, gated on the
  same `GIS_AUTO_MIGRATE` flag (reuse it rather than adding a second knob).
- `app.include_router(auth_router)` beside `app.include_router(gis_router)`
  (`main.py:67`).
- Add `dependencies=[RequireUser]` to the four decorators listed in the table
  (`@app.post("/nodes", dependencies=[RequireUser])`, etc.). No body changes —
  the handlers don't need the user object since we're not recording ownership.
- CORS needs no change: bearer tokens are a header, not a cookie, and
  `allow_headers=["*"]` already covers `Authorization`.

### Modified: `src/gis_api.py`

- Delete `require_api_key` (`gis_api.py:42-54`) and replace `Protected = Depends(...)`
  (`gis_api.py:54`) with `from auth import RequireUser as Protected`. The four
  routes that already carry `dependencies=[Protected]` (lines 435, 498, 603, 776)
  then need no edit. Nothing in the repo sends `X-API-Key`, so this drops one
  unused, non-constant-time secret path in favour of a single auth mechanism.
- Update the `/gis/config` response (`gis_api.py:416`) to include
  `"auth_required": True` so the frontend can discover the gate rather than
  hardcode it.

### Modified: `src/gis_runtime.py`

- Drop `api_key` from `GisConfig` (`gis_runtime.py:117`) and the `GIS_API_KEY` read
  at `gis_runtime.py:141`.

### Modified: `src/requirements.txt`

Add `PyJWT` and `bcrypt`, pinned in the style of the existing file — check the
current releases when installing; `PyJWT==2.10.1` and `bcrypt==4.2.1` are the
known-good floor.

### Modified: `GIS_PLAN.md`

Replace the `GIS_API_KEY` paragraph (`GIS_PLAN.md:411-413`) with the login
description, and add `AUTH_SECRET` / `AUTH_TOKEN_TTL` to the env var list near
`GIS_PLAN.md:424-431`.

## New environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `AUTH_SECRET` | yes, to log in at all | none | Long random string, e.g. `python -c "import secrets;print(secrets.token_urlsafe(48))"`. Set in Railway. Rotating it invalidates every issued token. |
| `AUTH_TOKEN_TTL` | no | `28800` | Token lifetime in seconds. |

`GIS_API_KEY` becomes unused and can be deleted from Railway.

## Verification

1. **Schema** — start the app (`uvicorn main:app --app-dir src --reload`) with
   `AUTH_SECRET` set; the log should show the auth DDL applied. Confirm with
   `\d public.users` in psql (local PostGIS is on port 5433 per `docker-compose.yaml`).
2. **Create a user** — `python src/create_user.py you@example.com`, then re-run it
   to confirm the upsert resets the password rather than erroring.
3. **Public reads still work with no token** —
   `curl -s $API/gis/layers`, `/gis/config`, `/gis/buildings?bbox=...`, `/nodes`,
   `/regions`, `/splat_nodes` all return 200. This is the requirement that must not
   regress.
4. **Uploads are blocked anonymously** —
   `curl -i -X POST $API/gis/jobs -H 'content-type: application/json' -d '{"layer_type":"tiff","name":"t","files":[{"filename":"a.tif","size_bytes":10}]}'`
   → 401. Same for `POST /nodes`, `POST /regions`, `POST /jobs`, and both `DELETE`s.
5. **Login** —
   `curl -s -X POST $API/auth/login -H 'content-type: application/json' -d '{"email":"you@example.com","password":"..."}'`
   → 200 + token. Wrong password → 401 with the generic message; six wrong tries
   → 429. `GET /auth/me` with the token → 200; with a garbage token → 401.
6. **Full upload round trip with the token** — repeat step 4's `POST /gis/jobs`
   with `-H "Authorization: Bearer $TOKEN"` → 201 with presigned PUT URLs; `PUT`
   the file to the returned URL; `POST /gis/jobs/{id}/start` with the header → 202;
   poll `GET /gis/jobs/{id}` (no token) until `done`; confirm the new layer appears
   in `GET /gis/layers`. Then `DELETE /gis/layers/{id}` with the header → success.
   This proves the gate doesn't break the pipeline itself.
7. **Expiry** — set `AUTH_TOKEN_TTL=5`, log in, wait, and confirm a protected call
   returns 401 rather than 500.
8. **Fail-closed** — unset `AUTH_SECRET` and restart: the app still boots, GETs
   still return 200, `POST /auth/login` returns 503, protected routes return 401.

## Out of scope (flagged, not done)

- `GET /splat-url` (`main.py:78`) signs a GET URL for **any** bucket key. It stays
  public because the viewer needs it, but it should later be narrowed to the
  `models/` prefix the way `/gis/asset-url` is narrowed to `gis/`
  (`gis_api.py:818`). Not part of the login work.
- Per-user ownership of jobs/layers, roles/admin, refresh tokens, and password-
  reset-by-email — all deferred per the decisions above.
