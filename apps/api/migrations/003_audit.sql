CREATE TABLE IF NOT EXISTS audit_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject_id TEXT NULL,
  tenant_id TEXT NULL,
  space_id TEXT NULL,
  resource_type TEXT NOT NULL,
  action TEXT NOT NULL,
  tool_ref TEXT NULL,
  workflow_ref TEXT NULL,
  policy_decision JSONB NULL,
  input_digest JSONB NULL,
  output_digest JSONB NULL,
  idempotency_key TEXT NULL,
  result TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  run_id TEXT NULL,
  step_id TEXT NULL,
  error_category TEXT NULL,
  latency_ms INT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_trace_idx
  ON audit_events (trace_id);

CREATE INDEX IF NOT EXISTS audit_events_subject_time_idx
  ON audit_events (subject_id, timestamp DESC);

