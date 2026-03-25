CREATE TABLE IF NOT EXISTS memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  owner_subject_id TEXT NULL,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NULL,
  content_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  write_policy TEXT NOT NULL,
  source_ref JSONB NULL,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_entries_scope_time_idx
  ON memory_entries (tenant_id, space_id, scope, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_entries_owner_time_idx
  ON memory_entries (tenant_id, space_id, owner_subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_entries_type_time_idx
  ON memory_entries (tenant_id, space_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_task_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  phase TEXT NOT NULL,
  plan JSONB NULL,
  artifacts_digest JSONB NULL,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_task_states_unique
  ON memory_task_states (tenant_id, space_id, run_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS memory_session_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  context_digest JSONB NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_session_contexts_scope_idx
  ON memory_session_contexts (tenant_id, space_id, subject_id, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS memory_session_contexts_unique
  ON memory_session_contexts (tenant_id, space_id, subject_id, session_id);

CREATE TABLE IF NOT EXISTS memory_user_preferences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  pref_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id, pref_key)
);
