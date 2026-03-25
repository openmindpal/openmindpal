CREATE TABLE IF NOT EXISTS audit_siem_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  secret_id UUID NOT NULL REFERENCES secret_records(id),
  batch_size INT NOT NULL DEFAULT 200,
  timeout_ms INT NOT NULL DEFAULT 5000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_siem_destinations_unique_name
  ON audit_siem_destinations (tenant_id, name);

CREATE INDEX IF NOT EXISTS audit_siem_destinations_by_tenant
  ON audit_siem_destinations (tenant_id, enabled);

CREATE TABLE IF NOT EXISTS audit_siem_cursors (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  last_ts TIMESTAMPTZ NULL,
  last_event_id UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, destination_id)
);

CREATE TABLE IF NOT EXISTS audit_siem_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_siem_outbox_unique_event
  ON audit_siem_outbox (tenant_id, destination_id, event_id);

CREATE INDEX IF NOT EXISTS audit_siem_outbox_pending
  ON audit_siem_outbox (tenant_id, destination_id, next_attempt_at, event_ts, event_id);

CREATE TABLE IF NOT EXISTS audit_siem_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  destination_id UUID NOT NULL REFERENCES audit_siem_destinations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL,
  last_error_digest JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_siem_dlq_by_dest
  ON audit_siem_dlq (tenant_id, destination_id, created_at DESC);

