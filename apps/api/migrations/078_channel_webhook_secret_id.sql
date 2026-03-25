ALTER TABLE channel_webhook_configs
  ALTER COLUMN secret_env_key DROP NOT NULL;

ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS secret_id UUID NULL;

