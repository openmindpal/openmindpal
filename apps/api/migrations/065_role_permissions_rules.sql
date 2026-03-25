ALTER TABLE role_permissions
  ADD COLUMN IF NOT EXISTS field_rules_read JSONB NULL,
  ADD COLUMN IF NOT EXISTS field_rules_write JSONB NULL,
  ADD COLUMN IF NOT EXISTS row_filters_read JSONB NULL,
  ADD COLUMN IF NOT EXISTS row_filters_write JSONB NULL;

