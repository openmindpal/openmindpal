ALTER TABLE page_template_versions
  ADD COLUMN IF NOT EXISTS ui_json JSONB NULL;

