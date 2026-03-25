ALTER TABLE provider_bindings
  ADD COLUMN IF NOT EXISTS base_url TEXT NULL;

UPDATE provider_bindings
SET base_url = CASE provider
  WHEN 'openai' THEN 'https://api.openai.com'
  WHEN 'mock' THEN 'http://mock.local'
  ELSE base_url
END
WHERE base_url IS NULL;
