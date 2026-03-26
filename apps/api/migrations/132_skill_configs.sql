-- Skill Config Table
-- 存储Skill的运行时配置参数，支持user/space/tenant三级作用域

CREATE TABLE IF NOT EXISTS skill_configs (
  config_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  skill_name   TEXT NOT NULL,
  config_key   TEXT NOT NULL,
  config_value JSONB NOT NULL DEFAULT '{}',
  scope_type   TEXT NOT NULL DEFAULT 'tenant',  -- user / space / tenant
  scope_id     TEXT NOT NULL,
  changed_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT skill_configs_unique UNIQUE (tenant_id, skill_name, config_key, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_configs_lookup
  ON skill_configs(tenant_id, skill_name, scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_skill_configs_skill
  ON skill_configs(tenant_id, skill_name);

COMMENT ON TABLE skill_configs IS 'Skill运行时配置参数，支持多级作用域覆盖';
COMMENT ON COLUMN skill_configs.scope_type IS '作用域类型: user=用户级, space=空间级, tenant=租户级';
