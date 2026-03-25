-- 121: SSO 登录状态表 (架构-05 AuthN/SSO 集成)
-- 代码中 ssoRuntime.ts 与 ssoOidcRuntime.ts 引用，但之前迁移遗漏

CREATE TABLE IF NOT EXISTS sso_login_states (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL,
  provider_id    TEXT NOT NULL,
  state          TEXT NOT NULL UNIQUE,
  nonce          TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  consumed_at    TIMESTAMPTZ NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_login_states_expires_idx
  ON sso_login_states (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS sso_login_states_tenant_idx
  ON sso_login_states (tenant_id, created_at DESC);

COMMENT ON TABLE sso_login_states IS 'SSO/OIDC 登录流程临时状态表，用于 CSRF 防护和 nonce 验证';
