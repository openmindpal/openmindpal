CREATE TABLE IF NOT EXISTS artifact_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  download_token_expires_in_sec INT NOT NULL DEFAULT 300,
  download_token_max_uses INT NOT NULL DEFAULT 1,
  watermark_headers_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS artifact_policies_lookup_idx
  ON artifact_policies (tenant_id, scope_type, scope_id);

