ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS compensation_enc_format TEXT NULL,
  ADD COLUMN IF NOT EXISTS compensation_key_version INT NULL,
  ADD COLUMN IF NOT EXISTS compensation_encrypted_payload JSONB NULL;

