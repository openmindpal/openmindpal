ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS policy_snapshot_ref TEXT NULL;

