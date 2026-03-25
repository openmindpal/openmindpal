-- NL2UI Generation Cache Table
-- 用于缓存 AI 生成的 UI 配置，支持快速回放和学习

CREATE TABLE IF NOT EXISTS nl2ui_generation_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    user_input_hash VARCHAR(64) NOT NULL, -- MD5 hash of user input for deduplication
    generated_config JSONB NOT NULL, -- Full generated UI config
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL, -- Auto-expire after 7 days
    
    -- Indexes for fast lookup
    CONSTRAINT unique_tenant_user_input UNIQUE (tenant_id, user_id, user_input_hash)
);

CREATE INDEX IF NOT EXISTS idx_nl2ui_cache_tenant_user 
ON nl2ui_generation_cache(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_nl2ui_cache_expires 
ON nl2ui_generation_cache(expires_at);

-- Add comment
COMMENT ON TABLE nl2ui_generation_cache IS 'NL2UI 生成结果缓存表，存储自然语言到 UI 配置的映射，TTL=7 天';
COMMENT ON COLUMN nl2ui_generation_cache.generated_config IS '完整的 UI 配置 JSON，包含 layout、blocks、dataBindings 等';
