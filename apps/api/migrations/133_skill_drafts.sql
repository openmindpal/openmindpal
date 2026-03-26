-- Skill Drafts Table
-- 存储用户生成的Skill草稿，支持审核和发布流程

CREATE TABLE IF NOT EXISTS skill_drafts (
  draft_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  skill_name   TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  manifest     JSONB NOT NULL DEFAULT '{}',
  index_code   TEXT NOT NULL DEFAULT '',
  routes_code  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft / reviewing / approved / rejected / published
  created_by   TEXT NOT NULL,
  approved_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_tenant
  ON skill_drafts(tenant_id);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_creator
  ON skill_drafts(tenant_id, created_by);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_status
  ON skill_drafts(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_skill_drafts_name
  ON skill_drafts(tenant_id, skill_name);

COMMENT ON TABLE skill_drafts IS 'Skill草稿存储，支持用户自定义技能的创建和审核发布流程';
COMMENT ON COLUMN skill_drafts.status IS '草稿状态: draft=草稿, reviewing=审核中, approved=已批准, rejected=已拒绝, published=已发布';
