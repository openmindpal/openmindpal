ALTER TABLE tool_network_policies
  ADD COLUMN IF NOT EXISTS rules_json JSONB NOT NULL DEFAULT '[]'::jsonb;

