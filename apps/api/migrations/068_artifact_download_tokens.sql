CREATE TABLE IF NOT EXISTS artifact_download_tokens (
  token_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  artifact_id UUID NOT NULL REFERENCES artifacts(artifact_id),
  issued_by_subject_id TEXT REFERENCES subjects(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_download_tokens_hash_uidx
  ON artifact_download_tokens (token_hash);

CREATE INDEX IF NOT EXISTS artifact_download_tokens_lookup_idx
  ON artifact_download_tokens (tenant_id, space_id, artifact_id, expires_at);
