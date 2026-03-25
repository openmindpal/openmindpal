CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  version INT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  tags JSONB NULL,
  content_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_unique_version
  ON knowledge_documents (tenant_id, space_id, id, version);

CREATE INDEX IF NOT EXISTS knowledge_documents_by_scope
  ON knowledge_documents (tenant_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  chunk_index INT NOT NULL,
  start_offset INT NOT NULL,
  end_offset INT NOT NULL,
  snippet TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_unique
  ON knowledge_chunks (tenant_id, space_id, document_id, document_version, chunk_index);

CREATE INDEX IF NOT EXISTS knowledge_chunks_by_scope
  ON knowledge_chunks (tenant_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_index_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id),
  document_version INT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT NULL,
  attempt INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_index_jobs_by_scope
  ON knowledge_index_jobs (tenant_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_retrieval_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  query_digest JSONB NOT NULL,
  filters_digest JSONB NULL,
  candidate_count INT NOT NULL,
  cited_refs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_retrieval_logs_by_scope
  ON knowledge_retrieval_logs (tenant_id, space_id, created_at DESC);

