ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS created_by_subject_id TEXT NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS trigger TEXT NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NULL;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS runs_tenant_status_time_idx
  ON runs (tenant_id, status, updated_at DESC);

WITH dups AS (
  SELECT
    tenant_id,
    idempotency_key,
    tool_ref,
    array_agg(run_id ORDER BY updated_at DESC) AS ids
  FROM runs
  WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL
  GROUP BY tenant_id, idempotency_key, tool_ref
  HAVING COUNT(*) > 1
),
to_null AS (
  SELECT unnest(ids[2:]) AS run_id
  FROM dups
)
UPDATE runs
SET idempotency_key = NULL, updated_at = now()
WHERE run_id IN (SELECT run_id FROM to_null);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_unique_idx
  ON runs (tenant_id, idempotency_key, tool_ref)
  WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL;
