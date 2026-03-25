ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS prev_hash TEXT NULL;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS event_hash TEXT NULL;

CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS audit_events_tenant_hash_idx
  ON audit_events (tenant_id, event_hash);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'audit_events_no_update'
      AND tgrelid = 'audit_events'::regclass
  ) THEN
    UPDATE audit_events
    SET error_category = CASE
      WHEN error_category IS NULL THEN NULL
      WHEN lower(error_category) IN ('policy_violation', 'validation_error', 'rate_limited', 'upstream_error', 'internal_error') THEN lower(error_category)
      WHEN lower(error_category) IN ('internal') THEN 'internal_error'
      WHEN lower(error_category) IN ('upstream') THEN 'upstream_error'
      WHEN lower(error_category) IN ('invalid_input', 'bad_request') THEN 'validation_error'
      WHEN lower(error_category) IN ('throttled', 'rate_limit') THEN 'rate_limited'
      ELSE 'internal_error'
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'audit_events_no_update'
      AND tgrelid = 'audit_events'::regclass
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_events_error_category_chk'
      AND conrelid = 'audit_events'::regclass
  ) THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_error_category_chk
      CHECK (
        error_category IS NULL
        OR error_category IN ('policy_violation', 'validation_error', 'rate_limited', 'upstream_error', 'internal_error')
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION audit_events_immutable_trigger()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events_is_append_only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_immutable_trigger();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_events_immutable_trigger();
