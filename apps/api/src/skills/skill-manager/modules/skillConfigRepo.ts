/**
 * Skill Config Repository
 *
 * 存储和管理Skill的运行时配置参数
 */
import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export interface SkillConfigRow {
  configId: string;
  tenantId: string;
  skillName: string;
  configKey: string;
  configValue: unknown;
  scopeType: "user" | "space" | "tenant";
  scopeId: string;
  changedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toConfigRow(r: any): SkillConfigRow {
  return {
    configId: r.config_id,
    tenantId: r.tenant_id,
    skillName: r.skill_name,
    configKey: r.config_key,
    configValue: r.config_value,
    scopeType: r.scope_type ?? "tenant",
    scopeId: r.scope_id,
    changedBy: r.changed_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Get a specific skill config value
 */
export async function getSkillConfig(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  configKey: string;
  scopeType: "user" | "space" | "tenant";
  scopeId: string;
}): Promise<SkillConfigRow | null> {
  const res = await params.pool.query(
    `SELECT * FROM skill_configs
     WHERE tenant_id = $1 AND skill_name = $2 AND config_key = $3
       AND scope_type = $4 AND scope_id = $5
     LIMIT 1`,
    [params.tenantId, params.skillName, params.configKey, params.scopeType, params.scopeId],
  );
  if (res.rowCount === 0) return null;
  return toConfigRow(res.rows[0]);
}

/**
 * List all configs for a skill at a given scope
 */
export async function listSkillConfigs(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  scopeType: "user" | "space" | "tenant";
  scopeId: string;
}): Promise<SkillConfigRow[]> {
  const res = await params.pool.query(
    `SELECT * FROM skill_configs
     WHERE tenant_id = $1 AND skill_name = $2
       AND scope_type = $3 AND scope_id = $4
     ORDER BY config_key ASC`,
    [params.tenantId, params.skillName, params.scopeType, params.scopeId],
  );
  return res.rows.map(toConfigRow);
}

/**
 * Set a skill config value (upsert)
 */
export async function setSkillConfig(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  configKey: string;
  configValue: unknown;
  scopeType: "user" | "space" | "tenant";
  scopeId: string;
  changedBy: string;
}): Promise<SkillConfigRow> {
  const res = await params.pool.query(
    `INSERT INTO skill_configs (tenant_id, skill_name, config_key, config_value, scope_type, scope_id, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, skill_name, config_key, scope_type, scope_id)
     DO UPDATE SET config_value = EXCLUDED.config_value, changed_by = EXCLUDED.changed_by, updated_at = now()
     RETURNING *`,
    [
      params.tenantId,
      params.skillName,
      params.configKey,
      JSON.stringify(params.configValue),
      params.scopeType,
      params.scopeId,
      params.changedBy,
    ],
  );
  return toConfigRow(res.rows[0]);
}

/**
 * Delete a skill config
 */
export async function deleteSkillConfig(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  configKey: string;
  scopeType: "user" | "space" | "tenant";
  scopeId: string;
}): Promise<boolean> {
  const res = await params.pool.query(
    `DELETE FROM skill_configs
     WHERE tenant_id = $1 AND skill_name = $2 AND config_key = $3
       AND scope_type = $4 AND scope_id = $5`,
    [params.tenantId, params.skillName, params.configKey, params.scopeType, params.scopeId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Get effective config value with scope fallback
 * Priority: user > space > tenant
 */
export async function getEffectiveSkillConfig(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  configKey: string;
  spaceId?: string | null;
  userId?: string | null;
}): Promise<{ value: unknown; scope: "user" | "space" | "tenant" } | null> {
  // Try user scope first
  if (params.userId) {
    const userConfig = await getSkillConfig({
      pool: params.pool,
      tenantId: params.tenantId,
      skillName: params.skillName,
      configKey: params.configKey,
      scopeType: "user",
      scopeId: params.userId,
    });
    if (userConfig) return { value: userConfig.configValue, scope: "user" };
  }

  // Try space scope
  if (params.spaceId) {
    const spaceConfig = await getSkillConfig({
      pool: params.pool,
      tenantId: params.tenantId,
      skillName: params.skillName,
      configKey: params.configKey,
      scopeType: "space",
      scopeId: params.spaceId,
    });
    if (spaceConfig) return { value: spaceConfig.configValue, scope: "space" };
  }

  // Try tenant scope
  const tenantConfig = await getSkillConfig({
    pool: params.pool,
    tenantId: params.tenantId,
    skillName: params.skillName,
    configKey: params.configKey,
    scopeType: "tenant",
    scopeId: params.tenantId,
  });
  if (tenantConfig) return { value: tenantConfig.configValue, scope: "tenant" };

  return null;
}
