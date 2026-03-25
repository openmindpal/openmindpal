CREATE TABLE IF NOT EXISTS model_provider_registry (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NULL,
  PRIMARY KEY (tenant_id, provider)
);

INSERT INTO model_provider_registry (tenant_id, provider, status, reason)
SELECT t.id, p.provider, 'enabled', NULL
FROM tenants t
CROSS JOIN (
  VALUES
    ('openai'),
    ('mock'),
    ('openai_compatible'),
    ('deepseek'),
    ('hunyuan'),
    ('qianwen'),
    ('zhipu'),
    ('doubao'),
    ('kimi'),
    ('kimimax')
) AS p(provider)
ON CONFLICT (tenant_id, provider) DO NOTHING;

