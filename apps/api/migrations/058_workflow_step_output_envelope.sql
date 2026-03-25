ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS output_enc_format TEXT NULL,
  ADD COLUMN IF NOT EXISTS output_key_version INT NULL,
  ADD COLUMN IF NOT EXISTS output_encrypted_payload JSONB NULL;

