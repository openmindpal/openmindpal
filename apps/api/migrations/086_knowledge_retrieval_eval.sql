CREATE TABLE IF NOT EXISTS knowledge_retrieval_eval_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  queries JSONB NOT NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_eval_sets_by_scope
  ON knowledge_retrieval_eval_sets (tenant_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  eval_set_id UUID NOT NULL REFERENCES knowledge_retrieval_eval_sets(id),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  metrics JSONB NULL,
  results JSONB NULL,
  failures JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_eval_runs_by_scope
  ON knowledge_retrieval_eval_runs (tenant_id, space_id, eval_set_id, created_at DESC);

