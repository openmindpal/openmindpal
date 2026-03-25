-- 116: ABAC policies table + row filters / field rules evolution (架构-05 §3.2 / §3.3)

-- ABAC policies: attribute-based access control policies used by authz engine
CREATE TABLE IF NOT EXISTS abac_policies (
  policy_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  policy_name    TEXT NOT NULL,
  description    JSONB,
  resource_type  TEXT NOT NULL DEFAULT '*',
  action         TEXT NOT NULL DEFAULT '*',
  priority       INT NOT NULL DEFAULT 100,
  effect         TEXT NOT NULL DEFAULT 'deny',   -- 'deny' | 'allow'
  conditions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_name)
);
CREATE INDEX IF NOT EXISTS idx_abac_policies_lookup
  ON abac_policies(tenant_id, resource_type, action, enabled, priority);

-- Space membership table for space_member row filter kind
CREATE TABLE IF NOT EXISTS space_members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  space_id       TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member' | 'viewer'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_space_members_subject ON space_members(tenant_id, subject_id);

-- Org hierarchy table for org_hierarchy row filter kind
CREATE TABLE IF NOT EXISTS org_units (
  org_unit_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  parent_id      UUID REFERENCES org_units(org_unit_id),
  org_name       TEXT NOT NULL,
  org_path       TEXT NOT NULL DEFAULT '/',  -- materialized path e.g. '/root/dept_a/team_1'
  depth          INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, org_path)
);
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON org_units(tenant_id, parent_id);

-- Subject org assignment
CREATE TABLE IF NOT EXISTS subject_org_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  subject_id     TEXT NOT NULL,
  org_unit_id    UUID NOT NULL REFERENCES org_units(org_unit_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, org_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_org_assignments_org ON subject_org_assignments(tenant_id, org_unit_id);

-- Add conditional field rules support to role_permissions
ALTER TABLE role_permissions
  ADD COLUMN IF NOT EXISTS field_rules_condition JSONB NULL;

-- Comment: field_rules_condition stores ABAC-style conditions under which
-- the field rules apply, e.g. { "when": { "kind": "time_window", ... } }
-- When NULL, the field rules always apply (backward compatible).
