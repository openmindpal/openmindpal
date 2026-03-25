-- 113: Multi-agent collaboration protocol (架构-18)
-- Agent role registry, communication protocol, task delegation, shared permission context

-- Agent role definitions per collab run
CREATE TABLE IF NOT EXISTS collab_agent_roles (
  agent_role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id UUID NOT NULL,
  role_name     TEXT NOT NULL,
  agent_type    TEXT NOT NULL DEFAULT 'llm',       -- llm | human | tool_executor | reviewer | planner
  capabilities  JSONB DEFAULT '[]'::jsonb,          -- declared tool/resource capabilities
  constraints   JSONB DEFAULT '{}'::jsonb,           -- max_steps, max_wall_time_ms, allowed_tools[], denied_tools[]
  status        TEXT NOT NULL DEFAULT 'active',      -- active | suspended | completed | revoked
  policy_snapshot_ref TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);

-- Task delegation / assignment records
CREATE TABLE IF NOT EXISTS collab_task_assignments (
  assignment_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id  UUID NOT NULL,
  task_id        UUID NOT NULL,
  assigned_role  TEXT NOT NULL,
  assigned_by    TEXT,                               -- role_name of assigner
  priority       INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | executing | completed | failed | rejected
  input_digest   JSONB,
  output_digest  JSONB,
  deadline_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collab_task_assignments_run ON collab_task_assignments(tenant_id, collab_run_id, status);

-- Shared permission context snapshot for collab sessions
CREATE TABLE IF NOT EXISTS collab_permission_contexts (
  context_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  collab_run_id  UUID NOT NULL,
  role_name      TEXT NOT NULL,
  effective_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_rules    JSONB,
  row_filters    JSONB,
  policy_snapshot_ref TEXT,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, collab_run_id, role_name)
);
