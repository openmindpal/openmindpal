CREATE TABLE IF NOT EXISTS eval_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT NULL,
  cases_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS eval_suites_tenant_idx
  ON eval_suites (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  suite_id UUID NOT NULL REFERENCES eval_suites(id),
  changeset_id UUID NULL REFERENCES governance_changesets(id),
  status TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_digest JSONB NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eval_runs_suite_idx
  ON eval_runs (tenant_id, suite_id, created_at DESC);

CREATE INDEX IF NOT EXISTS eval_runs_changeset_idx
  ON eval_runs (tenant_id, changeset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS changeset_eval_bindings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  changeset_id UUID NOT NULL REFERENCES governance_changesets(id),
  suite_id UUID NOT NULL REFERENCES eval_suites(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, changeset_id, suite_id)
);

CREATE INDEX IF NOT EXISTS changeset_eval_bindings_lookup_idx
  ON changeset_eval_bindings (tenant_id, changeset_id, created_at ASC);

