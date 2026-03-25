CREATE TABLE IF NOT EXISTS audit_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NULL,
  event JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS audit_outbox_ready_idx
  ON audit_outbox (status, next_attempt_at);

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS outbox_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_outbox_id_uniq
  ON audit_events (outbox_id)
  WHERE outbox_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_outbox_status_chk'
      AND conrelid = 'audit_outbox'::regclass
  ) THEN
    ALTER TABLE audit_outbox
      ADD CONSTRAINT audit_outbox_status_chk
      CHECK (status IN ('queued', 'processing', 'succeeded', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_events_outbox_id_fk'
      AND conrelid = 'audit_events'::regclass
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_outbox_id_fk
      FOREIGN KEY (outbox_id)
      REFERENCES audit_outbox (outbox_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 8;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS backoff_ms_base INT NOT NULL DEFAULT 500;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS dlq_threshold INT NOT NULL DEFAULT 8;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS alert_threshold INT NOT NULL DEFAULT 3;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS alert_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ NULL;

ALTER TABLE audit_siem_destinations
  ADD COLUMN IF NOT EXISTS last_alert_digest JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_siem_destinations_retry_chk'
      AND conrelid = 'audit_siem_destinations'::regclass
  ) THEN
    ALTER TABLE audit_siem_destinations
      ADD CONSTRAINT audit_siem_destinations_retry_chk
      CHECK (
        max_attempts BETWEEN 1 AND 50
        AND backoff_ms_base BETWEEN 0 AND 60000
        AND dlq_threshold BETWEEN 1 AND 50
        AND alert_threshold BETWEEN 1 AND 100
      );
  END IF;
END $$;

ALTER TABLE audit_siem_dlq
  ADD COLUMN IF NOT EXISTS alert_triggered_at TIMESTAMPTZ NULL;

ALTER TABLE audit_siem_dlq
  ADD COLUMN IF NOT EXISTS alert_digest JSONB NULL;
