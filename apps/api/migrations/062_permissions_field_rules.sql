ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS field_rules_read JSONB NULL,
  ADD COLUMN IF NOT EXISTS field_rules_write JSONB NULL;

