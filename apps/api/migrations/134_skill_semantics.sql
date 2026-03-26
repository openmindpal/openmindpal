-- 技能语义向量表
-- 存储每个技能的语义向量，用于相似度检索和重复检测

CREATE TABLE IF NOT EXISTS skill_semantics (
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  skill_name       TEXT NOT NULL,
  display_name     JSONB,
  description      JSONB,
  semantic_text    TEXT NOT NULL DEFAULT '',
  semantic_minhash INT[] NOT NULL DEFAULT '{}',
  layer            TEXT NOT NULL DEFAULT 'extension',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, skill_name)
);

-- 索引：加速语义检索
CREATE INDEX IF NOT EXISTS idx_skill_semantics_tenant_enabled
  ON skill_semantics (tenant_id, enabled);

CREATE INDEX IF NOT EXISTS idx_skill_semantics_minhash
  ON skill_semantics USING GIN (semantic_minhash);

COMMENT ON TABLE skill_semantics IS '技能语义向量表，用于相似度检索和重复检测';
COMMENT ON COLUMN skill_semantics.semantic_text IS '语义文本（名称+描述+参数拼接）';
COMMENT ON COLUMN skill_semantics.semantic_minhash IS 'Minhash语义向量';
COMMENT ON COLUMN skill_semantics.layer IS '技能层级：kernel/builtin/extension';
