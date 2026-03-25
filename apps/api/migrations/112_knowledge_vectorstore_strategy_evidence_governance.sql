ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS strategy_ref TEXT NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS vector_store_ref JSONB NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS degrade_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS knowledge_retrieval_logs_strategy_ref_idx
  ON knowledge_retrieval_logs (tenant_id, space_id, strategy_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_evidence_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  subject_id TEXT NULL,
  retrieval_log_id UUID NULL REFERENCES knowledge_retrieval_logs(id),
  document_id UUID NULL,
  document_version INT NULL,
  chunk_id UUID NULL,
  allowed BOOLEAN NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_evidence_access_events_by_scope
  ON knowledge_evidence_access_events (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_evidence_access_events_by_subject
  ON knowledge_evidence_access_events (tenant_id, space_id, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_evidence_retention_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  allow_snippet BOOLEAN NOT NULL DEFAULT true,
  retention_days INT NOT NULL DEFAULT 30,
  max_snippet_len INT NOT NULL DEFAULT 600,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id)
);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  config JSONB NOT NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, name, version)
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_strategies_by_scope
  ON knowledge_retrieval_strategies (tenant_id, space_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategy_actives (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  strategy_id UUID NOT NULL REFERENCES knowledge_retrieval_strategies(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id)
);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_strategy_eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  eval_set_id UUID NOT NULL REFERENCES knowledge_retrieval_eval_sets(id),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  strategies JSONB NOT NULL,
  metrics JSONB NULL,
  results JSONB NULL,
  failures JSONB NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_strategy_eval_runs_by_scope
  ON knowledge_retrieval_strategy_eval_runs (tenant_id, space_id, created_at DESC);

