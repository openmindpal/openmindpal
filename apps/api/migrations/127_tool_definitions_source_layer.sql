-- Migration: Add source_layer column to tool_definitions
-- Classifies tools into kernel / builtin / extension layers.

ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS source_layer TEXT NOT NULL DEFAULT 'builtin';

COMMENT ON COLUMN tool_definitions.source_layer IS
  'Classification layer: kernel (always auto-enabled), builtin (platform capability), extension (optional upper-layer)';

CREATE INDEX IF NOT EXISTS tool_definitions_source_layer_idx
  ON tool_definitions (tenant_id, source_layer);
