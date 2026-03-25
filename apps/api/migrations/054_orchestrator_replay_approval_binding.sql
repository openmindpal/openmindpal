ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS tool_ref TEXT NULL;

UPDATE approvals a
SET
  tool_ref = COALESCE(a.tool_ref, r.tool_ref),
  input_digest = CASE
    WHEN a.input_digest IS NULL THEN s.input_digest
    WHEN (a.input_digest ? 'resourceType') AND NOT (a.input_digest ? 'input') THEN s.input_digest
    ELSE a.input_digest
  END,
  updated_at = now()
FROM runs r
JOIN steps s ON s.run_id = r.run_id AND s.seq = 1
WHERE a.run_id = r.run_id;

CREATE INDEX IF NOT EXISTS runs_tenant_policy_ref_idx
  ON runs (tenant_id, policy_snapshot_ref);

CREATE INDEX IF NOT EXISTS steps_run_tool_input_digest_idx
  ON steps (run_id, tool_ref, input_digest);
