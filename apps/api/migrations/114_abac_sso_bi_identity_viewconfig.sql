-- 114: ABAC attributes, SSO/SCIM, BI/OLAP, multi-identity, user view config, skill lifecycle, schema lazy migration

-- ABAC: environment & time-based policy attributes (架构 §7 ABAC 演进)
CREATE TABLE IF NOT EXISTS policy_attribute_definitions (
  attr_def_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  attr_namespace TEXT NOT NULL,  -- 'env' | 'time' | 'geo' | 'device' | 'custom'
  attr_key       TEXT NOT NULL,  -- e.g. 'ip_range', 'time_window', 'day_of_week', 'geo_country'
  value_type     TEXT NOT NULL DEFAULT 'string',  -- string | number | boolean | string_list | time_range
  description    JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attr_namespace, attr_key)
);

-- Time-window / schedule-based access policies
CREATE TABLE IF NOT EXISTS policy_time_conditions (
  condition_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  policy_name    TEXT NOT NULL,
  policy_version INT NOT NULL DEFAULT 1,
  time_zone      TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  allowed_days   JSONB,            -- [1,2,3,4,5] (Mon-Fri)
  allowed_hours_start TEXT,        -- "09:00"
  allowed_hours_end   TEXT,        -- "18:00"
  ip_ranges      JSONB,            -- ["10.0.0.0/8", "192.168.0.0/16"]
  geo_countries  JSONB,            -- ["CN", "US"]
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_time_conditions_tenant ON policy_time_conditions(tenant_id, policy_name);

-- SSO/OIDC provider configurations (架构 §15.15 企业身份集成)
CREATE TABLE IF NOT EXISTS sso_provider_configs (
  provider_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  provider_type  TEXT NOT NULL DEFAULT 'oidc',   -- oidc | saml
  issuer_url     TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  client_secret_ref TEXT,                        -- references secrets
  scopes         TEXT NOT NULL DEFAULT 'openid profile email',
  redirect_uri   TEXT,
  jwks_uri       TEXT,
  userinfo_endpoint TEXT,
  claim_mappings JSONB DEFAULT '{}'::jsonb,      -- { "sub": "subjectId", "email": "email", "name": "displayName" }
  auto_provision BOOLEAN NOT NULL DEFAULT false,
  default_role_id TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active | disabled
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issuer_url)
);

-- SCIM provisioning configuration (架构 §15.15 企业身份集成)
CREATE TABLE IF NOT EXISTS scim_configs (
  scim_config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  bearer_token_hash TEXT NOT NULL,
  allowed_operations JSONB DEFAULT '["Users.list","Users.get","Users.create","Users.update","Users.delete","Groups.list","Groups.get"]'::jsonb,
  auto_provision BOOLEAN NOT NULL DEFAULT true,
  default_role_id TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- SCIM provisioned users log
CREATE TABLE IF NOT EXISTS scim_provisioned_users (
  scim_user_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  external_id    TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  display_name   TEXT,
  email          TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_scim_provisioned_users_subject ON scim_provisioned_users(tenant_id, subject_id);

-- BI/OLAP: materialized view definitions (架构 §4.1 BI/OLAP 集成)
CREATE TABLE IF NOT EXISTS analytics_materialized_views (
  view_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  view_name      TEXT NOT NULL,
  source_schema  TEXT NOT NULL,
  source_entity  TEXT NOT NULL,
  dimensions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  measures       JSONB NOT NULL DEFAULT '[]'::jsonb,
  time_granularity TEXT DEFAULT 'day',       -- minute | hour | day | week | month
  filter_expr    JSONB,
  refresh_strategy TEXT NOT NULL DEFAULT 'incremental',  -- full | incremental | manual
  refresh_cron   TEXT,
  last_refreshed_at TIMESTAMPTZ,
  row_count      BIGINT DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, view_name)
);

-- Semantic layer: metric definitions
CREATE TABLE IF NOT EXISTS analytics_metric_definitions (
  metric_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  metric_name    TEXT NOT NULL,
  display_name   JSONB,
  description    JSONB,
  view_id        UUID REFERENCES analytics_materialized_views(view_id),
  expression     TEXT NOT NULL,                    -- SQL expression e.g. SUM(amount)
  dimensions     JSONB DEFAULT '[]'::jsonb,
  unit           TEXT,
  version        INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, metric_name, version)
);

-- Analytics refresh jobs
CREATE TABLE IF NOT EXISTS analytics_refresh_jobs (
  refresh_job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  view_id        UUID NOT NULL REFERENCES analytics_materialized_views(view_id),
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | running | succeeded | failed
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  row_count      BIGINT DEFAULT 0,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_refresh_jobs_view ON analytics_refresh_jobs(tenant_id, view_id, status);

-- Multi-identity: subject identity linking (架构 §15.8 多身份)
CREATE TABLE IF NOT EXISTS subject_identity_links (
  link_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  primary_subject_id TEXT NOT NULL,
  linked_subject_id  TEXT NOT NULL,
  identity_label TEXT NOT NULL DEFAULT 'default',  -- 'work' | 'personal' | custom label
  provider_type  TEXT,                              -- 'local' | 'oidc' | 'saml' | 'scim'
  provider_ref   TEXT,                              -- reference to sso_provider_configs if applicable
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, primary_subject_id, linked_subject_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_identity_links_primary ON subject_identity_links(tenant_id, primary_subject_id, status);

-- User view config with variant support (架构 §3.2.3 个人级界面偏好)
CREATE TABLE IF NOT EXISTS user_view_configs (
  config_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  subject_id     TEXT NOT NULL,
  scope_type     TEXT NOT NULL DEFAULT 'tenant',   -- tenant | space
  scope_id       TEXT NOT NULL,
  target_type    TEXT NOT NULL,                     -- page | entity | view
  target_id      TEXT NOT NULL,
  variant        TEXT NOT NULL DEFAULT 'desktop',   -- desktop | mobile
  layout         JSONB,
  visible_fields JSONB,
  sort_config    JSONB,
  filter_config  JSONB,
  shortcuts      JSONB,
  version        INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, scope_type, scope_id, target_type, target_id, variant)
);

-- Personal dashboard shortcuts
CREATE TABLE IF NOT EXISTS user_dashboard_shortcuts (
  shortcut_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  subject_id     TEXT NOT NULL,
  scope_type     TEXT NOT NULL DEFAULT 'tenant',
  scope_id       TEXT NOT NULL,
  target_type    TEXT NOT NULL,                     -- page | entity | view | tool | workbench
  target_id      TEXT NOT NULL,
  display_name   JSONB,
  icon           TEXT,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_dashboard_shortcuts ON user_dashboard_shortcuts(tenant_id, subject_id, scope_type, scope_id);

-- Schema lazy migration tracking (架构 §6 惰性迁移)
CREATE TABLE IF NOT EXISTS schema_lazy_migration_log (
  log_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  schema_name    TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  from_version   INT NOT NULL,
  to_version     INT NOT NULL,
  migration_kind TEXT NOT NULL DEFAULT 'lazy_read',  -- lazy_read | lazy_write
  patch_applied  JSONB,
  migrated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schema_lazy_migration_log ON schema_lazy_migration_log(tenant_id, schema_name, record_id);

-- Skill lifecycle governance (架构 §10.0 自举 Skill)
CREATE TABLE IF NOT EXISTS skill_lifecycle_events (
  event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  skill_name     TEXT NOT NULL,
  skill_version  TEXT,
  from_status    TEXT,
  to_status      TEXT NOT NULL,                     -- draft | enabled_user_scope | enabled_space | enabled_tenant | disabled | revoked
  scope_type     TEXT NOT NULL DEFAULT 'user',      -- user | space | tenant
  scope_id       TEXT NOT NULL,
  changed_by     TEXT,
  approval_id    UUID,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_events ON skill_lifecycle_events(tenant_id, skill_name);
