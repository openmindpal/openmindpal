CREATE TABLE IF NOT EXISTS sync_merge_runs (
  merge_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  actor_subject_id TEXT NULL,
  input_digest TEXT NOT NULL,
  merge_digest TEXT NOT NULL,
  accepted_count INT NOT NULL DEFAULT 0,
  rejected_count INT NOT NULL DEFAULT 0,
  conflicts_count INT NOT NULL DEFAULT 0,
  transcript_json JSONB NOT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_merge_runs_tenant_space_time_idx
  ON sync_merge_runs (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sync_merge_runs_tenant_space_input_digest_idx
  ON sync_merge_runs (tenant_id, space_id, input_digest);

CREATE TABLE IF NOT EXISTS sync_conflict_tickets (
  ticket_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  merge_id TEXT NOT NULL,
  status TEXT NOT NULL,
  conflicts_json JSONB NOT NULL,
  resolved_merge_id TEXT NULL,
  abandoned_reason TEXT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_conflict_tickets_tenant_space_status_time_idx
  ON sync_conflict_tickets (tenant_id, space_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS sync_conflict_tickets_merge_id_idx
  ON sync_conflict_tickets (merge_id);

