CREATE TABLE IF NOT EXISTS device_executions (
  device_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  created_by_subject_id TEXT NULL,
  device_id UUID NOT NULL REFERENCES device_records(device_id),
  tool_ref TEXT NOT NULL,
  policy_snapshot_ref TEXT NULL,
  idempotency_key TEXT NULL,
  require_user_presence BOOLEAN NOT NULL DEFAULT false,
  input_json JSONB NULL,
  input_digest JSONB NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output_digest JSONB NULL,
  evidence_refs JSONB NULL,
  error_category TEXT NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  canceled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_executions_lookup_idx
  ON device_executions (tenant_id, device_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS device_executions_space_idx
  ON device_executions (tenant_id, space_id, status, created_at DESC);

