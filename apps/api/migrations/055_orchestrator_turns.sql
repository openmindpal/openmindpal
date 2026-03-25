CREATE TABLE IF NOT EXISTS orchestrator_turns (
  turn_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  message TEXT NOT NULL,
  tool_suggestions JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orchestrator_turns_tenant_space_time_idx
  ON orchestrator_turns (tenant_id, space_id, created_at DESC);

