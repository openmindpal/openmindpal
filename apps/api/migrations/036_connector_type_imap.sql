INSERT INTO connector_types (name, provider, auth_method, default_risk_level, default_egress_policy)
VALUES
  ('mail.imap', 'imap', 'password', 'high', '{"allowedDomains":[]}'::jsonb)
ON CONFLICT (name) DO NOTHING;

