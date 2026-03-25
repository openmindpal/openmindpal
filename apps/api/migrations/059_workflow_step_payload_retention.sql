ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS workflow_step_payload_retention_days INT NULL;

