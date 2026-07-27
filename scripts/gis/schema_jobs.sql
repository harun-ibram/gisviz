-- ============================================================================
-- GISViz — splat-generation jobs table
-- Additive to init-scripts/schema.sql; safe to run repeatedly (IF NOT EXISTS).
--
-- Tracks one photos -> splat run: a batch of photos is uploaded to R2 under
-- input_prefix, a Modal GPU worker turns them into a Gaussian splat with
-- COLMAP + splatfacto, and the resulting .ply is written back to R2 at
-- output_key. On success the backend copies output_key into the target
-- feature's model_path (osm.nodes or public.regions), which is what the
-- frontend viewer reads.
--
-- Kept in sync with the Job SQLModel in src/models.py.
-- Apply with:  psql "$DB_URL" -f scripts/gis/schema_jobs.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.jobs (
    id            TEXT PRIMARY KEY,                       -- uuid
    status        TEXT NOT NULL DEFAULT 'pending'         -- lifecycle state
                  CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    target_type   TEXT NOT NULL                           -- which table target_id points at
                  CHECK (target_type IN ('node', 'region')),
    target_id     TEXT NOT NULL,                          -- osm.nodes.node_id (as text) or public.regions.id
    input_prefix  TEXT NOT NULL,                          -- R2 key prefix holding the uploaded photos
    output_key    TEXT,                                   -- R2 key of the produced splat, once done
    modal_call_id TEXT,                                   -- Modal function-call id for the running job
    error         TEXT,                                   -- failure detail when status='failed'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Polled by the frontend per job, and used to sweep for stuck/running jobs.
CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs (status);

-- Find the jobs behind a given map feature (e.g. "show history for this node").
CREATE INDEX IF NOT EXISTS idx_jobs_target ON public.jobs (target_type, target_id);

-- Keep updated_at honest even for writers that forget to set it. The backend
-- sets it explicitly too; this is the backstop for manual SQL edits.
CREATE OR REPLACE FUNCTION public.jobs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_touch_updated_at ON public.jobs;
CREATE TRIGGER trg_jobs_touch_updated_at
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW
    EXECUTE FUNCTION public.jobs_touch_updated_at();
