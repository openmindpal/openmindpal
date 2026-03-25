-- Migration: base_url now includes the API version path (e.g. /v1).
-- Old behaviour: normalizeOpenAiCompatibleBaseUrl stripped trailing /v1 and
-- openaiChat.ts hard-coded /v1/chat/completions.
-- New behaviour: base_url keeps the version path, and the code appends only
-- /chat/completions.  Existing rows created under the old convention need
-- /v1 appended so they remain correct.

-- Only append /v1 when:
--   1. provider is not 'mock' (mock doesn't go through the OpenAI path)
--   2. base_url is NOT NULL and not empty
--   3. base_url does NOT already end with a version segment like /v1, /v2 … /v9
UPDATE provider_bindings
SET
  base_url = base_url || '/v1',
  updated_at = now()
WHERE provider <> 'mock'
  AND base_url IS NOT NULL
  AND base_url <> ''
  AND base_url !~ '/v[0-9]+$';
