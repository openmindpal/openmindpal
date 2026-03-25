CREATE INDEX IF NOT EXISTS oauth_grants_scope_updated_idx
  ON oauth_grants (tenant_id, space_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS subscriptions_scope_updated_idx
  ON subscriptions (tenant_id, space_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS audit_siem_destinations_tenant_updated_idx
  ON audit_siem_destinations (tenant_id, updated_at DESC);

