CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  created_by_subject_id TEXT NOT NULL,
  title TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_tenant_space_time_idx
  ON tasks (tenant_id, space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  from_agent_id TEXT NULL,
  from_role TEXT NOT NULL,
  intent TEXT NOT NULL,
  correlation JSONB NULL,
  inputs JSONB NULL,
  outputs JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_task_time_idx
  ON agent_messages (task_id, created_at DESC);

