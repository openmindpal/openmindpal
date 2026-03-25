ALTER TABLE entity_records
  ADD COLUMN IF NOT EXISTS owner_subject_id TEXT NULL;

CREATE INDEX IF NOT EXISTS entity_records_owner_idx
  ON entity_records (tenant_id, space_id, entity_name, owner_subject_id, updated_at DESC);

