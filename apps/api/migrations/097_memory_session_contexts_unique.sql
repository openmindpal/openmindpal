CREATE UNIQUE INDEX IF NOT EXISTS memory_session_contexts_unique
  ON memory_session_contexts (tenant_id, space_id, subject_id, session_id);

