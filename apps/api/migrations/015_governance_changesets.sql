CREATE TABLE IF NOT EXISTS governance_changesets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NULL,
  approved_by TEXT NULL,
  approved_at TIMESTAMPTZ NULL,
  released_by TEXT NULL,
  released_at TIMESTAMPTZ NULL,
  rollback_of UUID NULL REFERENCES governance_changesets(id),
  rollback_data JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_changesets_scope_idx
  ON governance_changesets (tenant_id, scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_changeset_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS governance_changeset_items_idx
  ON governance_changeset_items (changeset_id, created_at ASC);

