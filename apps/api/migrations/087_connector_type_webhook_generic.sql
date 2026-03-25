INSERT INTO connector_types (name, provider, auth_method, default_risk_level, default_egress_policy)
VALUES
  ('webhook.generic', 'webhook', 'none', 'low', '{"allowedDomains":[]}'::jsonb)
ON CONFLICT (name) DO NOTHING;
