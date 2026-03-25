ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS deadlettered_at TIMESTAMPTZ NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS last_error_digest JSONB NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS queue_job_id TEXT NULL;

CREATE INDEX IF NOT EXISTS steps_deadlettered_at_idx
  ON steps (deadlettered_at DESC)
  WHERE deadlettered_at IS NOT NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS reexec_of_run_id UUID NULL REFERENCES runs(run_id);

CREATE INDEX IF NOT EXISTS runs_reexec_of_run_id_idx
  ON runs (reexec_of_run_id);

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS deadlettered_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS jobs_deadlettered_at_idx
  ON jobs (deadlettered_at DESC)
  WHERE deadlettered_at IS NOT NULL;
