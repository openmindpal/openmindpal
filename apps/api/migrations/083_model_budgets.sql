CREATE TABLE IF NOT EXISTS model_budgets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  scene TEXT NULL,
  purpose TEXT NOT NULL,
  soft_daily_tokens INT NULL,
  hard_daily_tokens INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scope_type IN ('tenant', 'space', 'user', 'scene')),
  PRIMARY KEY (tenant_id, scope_type, scope_id, purpose)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'model_budgets'
      AND column_name = 'scene'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS model_budgets_tenant_scene_idx ON model_budgets (tenant_id, scene, updated_at DESC)';
  END IF;
END $$;
