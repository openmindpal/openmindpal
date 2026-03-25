ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS retention_days INT NULL;

CREATE INDEX IF NOT EXISTS memory_entries_expires_at_idx
  ON memory_entries (tenant_id, space_id, expires_at);

