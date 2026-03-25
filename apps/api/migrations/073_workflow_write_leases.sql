CREATE TABLE IF NOT EXISTS workflow_write_leases (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  owner_run_id TEXT NOT NULL,
  owner_step_id TEXT NOT NULL,
  owner_trace_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, resource_ref)
);

CREATE INDEX IF NOT EXISTS workflow_write_leases_expires_at_idx ON workflow_write_leases (expires_at);

