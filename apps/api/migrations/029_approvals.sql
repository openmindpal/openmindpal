CREATE TABLE IF NOT EXISTS approvals (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  run_id UUID NOT NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_subject_id TEXT NOT NULL,
  policy_snapshot_ref TEXT NULL,
  input_digest JSONB NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_id)
);

CREATE INDEX IF NOT EXISTS approvals_tenant_status_time_idx
  ON approvals (tenant_id, status, requested_at DESC);

CREATE TABLE IF NOT EXISTS approval_decisions (
  decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES approvals(approval_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  decision TEXT NOT NULL,
  reason TEXT NULL,
  decided_by_subject_id TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_decisions_approval_time_idx
  ON approval_decisions (approval_id, decided_at DESC);
