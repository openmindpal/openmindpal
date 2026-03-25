INSERT INTO connector_types (name, provider, auth_method, default_risk_level, default_egress_policy)
VALUES
  ('mail.exchange', 'exchange', 'oauth', 'high', '{"allowedDomains":["graph.microsoft.com"]}'::jsonb)
ON CONFLICT (name) DO NOTHING;

