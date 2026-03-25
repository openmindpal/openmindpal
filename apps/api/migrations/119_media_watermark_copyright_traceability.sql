-- 119: media_objects 增加水印/版权/溯源元数据字段 (架构-13 Skill 产出治理)

ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS watermark JSONB NULL;

ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS copyright JSONB NULL;

ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS traceability JSONB NULL;

-- watermark: { "algorithm": "invisible_dct", "payload": "tenant:xxx", "embedAt": "2026-..." }
-- copyright: { "owner": "...", "license": "CC-BY-4.0", "expires": "...", "restrictions": [...] }
-- traceability: { "originSkill": "media-pipeline", "originRunId": "...", "chainHash": "sha256:..." }

COMMENT ON COLUMN media_objects.watermark IS '水印元数据：算法、嵌入载荷、时间戳等';
COMMENT ON COLUMN media_objects.copyright IS '版权元数据：持有者、许可证类型、到期时间、限制条件';
COMMENT ON COLUMN media_objects.traceability IS '溯源元数据：来源Skill、来源运行ID、链式哈希';
