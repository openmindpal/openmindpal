CREATE TABLE IF NOT EXISTS model_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  space_id TEXT NULL,
  subject_id TEXT NULL,
  user_id TEXT NULL,
  scene TEXT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  prompt_tokens INT NULL,
  completion_tokens INT NULL,
  total_tokens INT NULL,
  latency_ms INT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_time_idx
  ON model_usage_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_space_time_idx
  ON model_usage_events (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_tenant_model_time_idx
  ON model_usage_events (tenant_id, model_ref, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'model_usage_events'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS model_usage_events_tenant_user_time_idx ON model_usage_events (tenant_id, user_id, created_at DESC)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'model_usage_events'
      AND column_name = 'scene'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS model_usage_events_tenant_scene_time_idx ON model_usage_events (tenant_id, scene, created_at DESC)';
  END IF;
END $$;
