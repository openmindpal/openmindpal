CREATE TABLE IF NOT EXISTS media_objects (
  media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  content_type TEXT NOT NULL,
  byte_size INT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  source JSONB NULL,
  provenance JSONB NULL,
  safety_digest JSONB NULL,
  content_bytes BYTEA NOT NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_objects_scope_time_idx
  ON media_objects (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS media_objects_tenant_sha_idx
  ON media_objects (tenant_id, sha256);

CREATE TABLE IF NOT EXISTS media_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  media_id UUID NOT NULL REFERENCES media_objects(media_id),
  ops JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_digest JSONB NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_jobs_tenant_status_time_idx
  ON media_jobs (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS media_jobs_tenant_media_idx
  ON media_jobs (tenant_id, media_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_derivatives (
  derivative_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  media_id UUID NOT NULL REFERENCES media_objects(media_id),
  job_id UUID NULL REFERENCES media_jobs(job_id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  meta JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_derivatives_tenant_media_idx
  ON media_derivatives (tenant_id, media_id, created_at DESC);

