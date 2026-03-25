ALTER TABLE provider_bindings
ADD COLUMN IF NOT EXISTS chat_completions_path TEXT;

