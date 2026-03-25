-- 120: Runner egress 审计日志表 (架构-13 Skill 出站治理)

CREATE TABLE IF NOT EXISTS runner_egress_audit_log (
  log_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  tool_ref       TEXT NOT NULL,
  host           TEXT NOT NULL,
  method         TEXT NOT NULL,
  allowed        BOOLEAN NOT NULL,
  policy_match   JSONB NULL,
  status         INT NULL,
  error_category TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_tenant_time_idx
  ON runner_egress_audit_log (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_host_idx
  ON runner_egress_audit_log (tenant_id, host, created_at DESC);

CREATE INDEX IF NOT EXISTS runner_egress_audit_log_request_idx
  ON runner_egress_audit_log (request_id);

-- 保留策略：默认 90 天后可安全清理
COMMENT ON TABLE runner_egress_audit_log IS 'Skill 执行期间的出站网络请求审计日志，由 Runner 服务批量写入';
