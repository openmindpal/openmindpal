CREATE TABLE IF NOT EXISTS audit_retention_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  retention_days INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_legal_holds (
  hold_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  from_ts TIMESTAMPTZ NULL,
  to_ts TIMESTAMPTZ NULL,
  subject_id TEXT NULL,
  trace_id TEXT NULL,
  run_id TEXT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by TEXT NULL,
  released_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_status_idx
  ON audit_legal_holds (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_legal_holds_scope_idx
  ON audit_legal_holds (tenant_id, scope_type, scope_id, status);

CREATE INDEX IF NOT EXISTS audit_legal_holds_trace_idx
  ON audit_legal_holds (tenant_id, trace_id);

CREATE TABLE IF NOT EXISTS audit_exports (
  export_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  filters JSONB NOT NULL,
  artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  artifact_ref TEXT NULL,
  error_digest JSONB NULL
);

CREATE INDEX IF NOT EXISTS audit_exports_tenant_time_idx
  ON audit_exports (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_exports_tenant_status_idx
  ON audit_exports (tenant_id, status, created_at DESC);

