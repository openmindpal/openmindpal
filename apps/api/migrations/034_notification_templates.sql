CREATE TABLE IF NOT EXISTS notification_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope_type, scope_id, key, channel)
);

CREATE INDEX IF NOT EXISTS notification_templates_scope_idx
  ON notification_templates (tenant_id, scope_type, scope_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_template_versions (
  template_id UUID NOT NULL REFERENCES notification_templates(template_id),
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_i18n JSONB NOT NULL,
  params_schema JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  PRIMARY KEY (template_id, version)
);

CREATE INDEX IF NOT EXISTS notification_template_versions_lookup_idx
  ON notification_template_versions (template_id, status, version DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  template_id UUID NOT NULL REFERENCES notification_templates(template_id),
  template_version INT NOT NULL,
  locale TEXT NOT NULL,
  params_digest JSONB NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  canceled_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS notification_outbox_scope_status_idx
  ON notification_outbox (tenant_id, space_id, status, created_at DESC);

