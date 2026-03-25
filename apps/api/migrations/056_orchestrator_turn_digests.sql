ALTER TABLE orchestrator_turns
  ADD COLUMN IF NOT EXISTS message_digest JSONB NULL,
  ADD COLUMN IF NOT EXISTS tool_suggestions_digest JSONB NULL;

