CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_time_idx
  ON policy_snapshots (tenant_id, created_at DESC, snapshot_id DESC);

