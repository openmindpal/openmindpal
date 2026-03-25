CREATE TABLE IF NOT EXISTS safety_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_type, name)
);

CREATE TABLE IF NOT EXISTS safety_policy_versions (
  policy_id UUID NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  policy_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  PRIMARY KEY (policy_id, version),
  CONSTRAINT safety_policy_versions_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS safety_policy_versions_status_idx
  ON safety_policy_versions (policy_id, status, version DESC);

CREATE TABLE IF NOT EXISTS safety_policy_active_versions (
  tenant_id TEXT NOT NULL,
  policy_id UUID NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, policy_id),
  CONSTRAINT safety_policy_active_versions_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS safety_policy_active_overrides (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  policy_id UUID NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, policy_id),
  CONSTRAINT safety_policy_active_overrides_policy_fk
    FOREIGN KEY (policy_id) REFERENCES safety_policies(policy_id) ON DELETE CASCADE
);
