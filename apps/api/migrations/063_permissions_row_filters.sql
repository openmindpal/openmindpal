ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS row_filters_read JSONB NULL,
  ADD COLUMN IF NOT EXISTS row_filters_write JSONB NULL;

