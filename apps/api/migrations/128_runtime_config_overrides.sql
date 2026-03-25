-- runtime_config_overrides: governance control plane 的运行时配置覆盖表
-- 优先级: governance override > env var > registry default
CREATE TABLE IF NOT EXISTS runtime_config_overrides (
  tenant_id   TEXT NOT NULL,
  config_key  TEXT NOT NULL,
  config_value TEXT NOT NULL,
  description TEXT DEFAULT '',
  updated_by  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_runtime_config_overrides_tenant
  ON runtime_config_overrides (tenant_id);

-- 配置变更审计日志
CREATE TABLE IF NOT EXISTS config_change_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  config_key  TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  TEXT DEFAULT '',
  change_type TEXT NOT NULL DEFAULT 'set',  -- set | delete
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_change_audit_tenant_key
  ON config_change_audit_log (tenant_id, config_key, created_at DESC);
