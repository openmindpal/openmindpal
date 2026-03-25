ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS scope TEXT NULL;

ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS resource_type TEXT NULL;

ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS action TEXT NULL;

ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS idempotency_required BOOLEAN NULL;

CREATE INDEX IF NOT EXISTS tool_definitions_contract_idx
  ON tool_definitions (tenant_id, scope, resource_type, action);

