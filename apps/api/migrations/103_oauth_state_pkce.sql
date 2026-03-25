ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS pkce_enc_format TEXT NULL;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS pkce_key_version INT NULL;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS pkce_encrypted_payload JSONB NULL;
