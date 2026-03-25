ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'space';

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS owner_subject_id TEXT NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_visibility_idx
  ON knowledge_documents (tenant_id, space_id, visibility, owner_subject_id, created_at DESC);

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model_ref TEXT NULL;

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_minhash INT[] NULL;

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_scope_idx
  ON knowledge_chunks (tenant_id, space_id, embedding_updated_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_minhash_gin
  ON knowledge_chunks USING GIN (embedding_minhash);

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS rank_policy TEXT NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS stage_stats JSONB NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS ranked_evidence_refs JSONB NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS returned_count INT NULL;

ALTER TABLE knowledge_retrieval_logs
  ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS knowledge_embedding_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  embedding_model_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, document_id, document_version, embedding_model_ref)
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_jobs_by_scope
  ON knowledge_embedding_jobs (tenant_id, space_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_ingest_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_event_pk UUID NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  document_id UUID NULL,
  document_version INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, workspace_id, event_id)
);

CREATE INDEX IF NOT EXISTS knowledge_ingest_jobs_by_scope
  ON knowledge_ingest_jobs (tenant_id, space_id, status, updated_at DESC);

