-- 为 roles 表添加 (name, tenant_id) 唯一约束
-- 修复 ON CONFLICT (name, tenant_id) 语句报错问题

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_tenant_id_unique 
  ON roles (name, tenant_id);
