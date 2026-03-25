ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS input_enc_format TEXT NULL,
  ADD COLUMN IF NOT EXISTS input_key_version INT NULL,
  ADD COLUMN IF NOT EXISTS input_encrypted_payload JSONB NULL;

