ALTER TABLE device_policies
  ADD COLUMN IF NOT EXISTS ui_policy JSONB NULL;

ALTER TABLE device_policies
  ADD COLUMN IF NOT EXISTS evidence_policy JSONB NULL;

