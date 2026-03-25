ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS storage_provider TEXT NULL;

ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS storage_key TEXT NULL;

ALTER TABLE media_objects
  ALTER COLUMN content_bytes DROP NOT NULL;

CREATE INDEX IF NOT EXISTS media_objects_storage_idx
  ON media_objects (tenant_id, storage_provider, storage_key);

CREATE TABLE IF NOT EXISTS media_uploads (
  upload_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  total_bytes INT NOT NULL DEFAULT 0,
  created_by_subject_id TEXT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_uploads_scope_status_time_idx
  ON media_uploads (tenant_id, space_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS media_upload_parts (
  upload_id UUID NOT NULL REFERENCES media_uploads(upload_id),
  part_number INT NOT NULL,
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  byte_size INT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, part_number)
);

