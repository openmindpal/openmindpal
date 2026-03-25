-- 为 memory_entries 添加 minhash 向量索引列，支持语义召回
-- 与 knowledge_chunks 的 embedding 方案对齐（minhash:16@1）

ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS embedding_model_ref TEXT NULL;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS embedding_minhash INT[] NULL;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ NULL;

-- GIN 索引：支持 && (overlap) 运算符快速召回
CREATE INDEX IF NOT EXISTS memory_entries_embedding_minhash_gin_idx
  ON memory_entries USING GIN (embedding_minhash)
  WHERE deleted_at IS NULL AND embedding_minhash IS NOT NULL;

-- 辅助索引：按 embedding 更新时间排序（用于降级/回扫）
CREATE INDEX IF NOT EXISTS memory_entries_embedding_updated_idx
  ON memory_entries (tenant_id, space_id, embedding_updated_at DESC NULLS LAST)
  WHERE deleted_at IS NULL AND embedding_minhash IS NOT NULL;
