ALTER TABLE governance_changesets
  ADD COLUMN IF NOT EXISTS required_approvals INT NOT NULL DEFAULT 1;

ALTER TABLE governance_changesets
  ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low';

CREATE TABLE IF NOT EXISTS governance_changeset_approvals (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, changeset_id, approved_by)
);

CREATE INDEX IF NOT EXISTS governance_changeset_approvals_idx
  ON governance_changeset_approvals (tenant_id, changeset_id, approved_at ASC);

