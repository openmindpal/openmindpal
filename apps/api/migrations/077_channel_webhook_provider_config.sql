ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS provider_config JSONB NULL;

