ALTER TABLE provider_bindings
  ADD COLUMN IF NOT EXISTS secret_ids JSONB NULL;

UPDATE provider_bindings
SET secret_ids = jsonb_build_array(secret_id)
WHERE secret_ids IS NULL;

ALTER TABLE provider_bindings
  ALTER COLUMN secret_ids SET NOT NULL;

