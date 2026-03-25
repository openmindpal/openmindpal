ALTER TABLE tool_versions
  ADD COLUMN IF NOT EXISTS scan_summary JSONB NULL;

