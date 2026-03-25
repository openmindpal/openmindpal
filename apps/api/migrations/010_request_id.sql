ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS request_id TEXT NULL;

CREATE INDEX IF NOT EXISTS audit_events_request_idx
  ON audit_events (request_id);

