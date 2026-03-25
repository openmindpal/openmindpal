/**
 * configGovernanceRepo.ts — runtime 配置的 governance control plane 存储层
 *
 * 提供：
 * - 配置覆盖的 CRUD
 * - 批量加载覆盖 → RuntimeConfigOverrides 格式
 * - 配置变更审计日志
 */

import type { Pool } from "pg";
import {
  CONFIG_REGISTRY,
  findConfigEntry,
  getRuntimeMutableConfigs,
  validateConfigValue,
  parseConfigValue,
  type ConfigEntry,
  type RuntimeConfigOverrides,
  resolveRuntimeConfig,
  resolveAllRuntimeConfigs,
  type ResolvedConfig,
} from "@openslin/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigOverrideRow {
  configKey: string;
  configValue: string;
  description: string;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
}

export interface ConfigChangeAuditRow {
  id: string;
  configKey: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  changeType: "set" | "delete";
  createdAt: string;
}

export interface SetConfigResult {
  configKey: string;
  previousValue: string | null;
  newValue: string;
  source: "governance";
}

// ---------------------------------------------------------------------------
// Load overrides (for resolver)
// ---------------------------------------------------------------------------

/**
 * 从 DB 批量加载所有 governance 覆盖值。
 * 返回 RuntimeConfigOverrides 格式，可直接传给 resolveRuntimeConfig。
 */
export async function loadConfigOverrides(params: {
  pool: Pool;
  tenantId: string;
}): Promise<RuntimeConfigOverrides> {
  const res = await params.pool.query(
    `SELECT config_key, config_value FROM runtime_config_overrides WHERE tenant_id = $1`,
    [params.tenantId],
  );
  const overrides: RuntimeConfigOverrides = {};
  for (const row of res.rows) {
    overrides[String(row.config_key)] = String(row.config_value);
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * 列出所有 governance 配置覆盖。
 */
export async function listConfigOverrides(params: {
  pool: Pool;
  tenantId: string;
}): Promise<ConfigOverrideRow[]> {
  const res = await params.pool.query(
    `SELECT config_key, config_value, description, updated_by, updated_at, created_at
     FROM runtime_config_overrides
     WHERE tenant_id = $1
     ORDER BY config_key`,
    [params.tenantId],
  );
  return res.rows.map((r: any) => ({
    configKey: String(r.config_key),
    configValue: String(r.config_value),
    description: String(r.description ?? ""),
    updatedBy: String(r.updated_by ?? ""),
    updatedAt: String(r.updated_at),
    createdAt: String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Set (upsert)
// ---------------------------------------------------------------------------

/**
 * 设置/更新一个 governance 配置覆盖。
 * 仅允许 runtime-mutable 的配置项。
 */
export async function setConfigOverride(params: {
  pool: Pool;
  tenantId: string;
  configKey: string;
  configValue: string;
  description?: string;
  changedBy?: string;
}): Promise<SetConfigResult> {
  const entry = findConfigEntry(params.configKey);

  // 仅允许已注册且 runtime-mutable 的配置项
  if (!entry) {
    throw new Error(`config_not_registered:${params.configKey}`);
  }
  if (entry.level !== "runtime" || !entry.runtimeMutable) {
    throw new Error(`config_not_runtime_mutable:${params.configKey} (level=${entry.level})`);
  }

  // 值验证
  const validation = validateConfigValue(entry, params.configValue);
  if (!validation.valid) {
    throw new Error(`config_validation_failed:${validation.reason}`);
  }

  // 读取旧值
  const prev = await params.pool.query(
    `SELECT config_value FROM runtime_config_overrides WHERE tenant_id = $1 AND config_key = $2`,
    [params.tenantId, params.configKey],
  );
  const previousValue = prev.rowCount ? String(prev.rows[0].config_value) : null;

  // Upsert
  await params.pool.query(
    `INSERT INTO runtime_config_overrides (tenant_id, config_key, config_value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (tenant_id, config_key) DO UPDATE SET
       config_value = EXCLUDED.config_value,
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [params.tenantId, params.configKey, params.configValue, params.description ?? "", params.changedBy ?? ""],
  );

  // 审计日志
  await params.pool.query(
    `INSERT INTO config_change_audit_log (tenant_id, config_key, old_value, new_value, changed_by, change_type)
     VALUES ($1, $2, $3, $4, $5, 'set')`,
    [params.tenantId, params.configKey, previousValue, params.configValue, params.changedBy ?? ""],
  );

  return {
    configKey: params.configKey,
    previousValue,
    newValue: params.configValue,
    source: "governance",
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * 删除一个 governance 配置覆盖（回退到 env / default）。
 */
export async function deleteConfigOverride(params: {
  pool: Pool;
  tenantId: string;
  configKey: string;
  changedBy?: string;
}): Promise<{ deleted: boolean; previousValue: string | null }> {
  const prev = await params.pool.query(
    `SELECT config_value FROM runtime_config_overrides WHERE tenant_id = $1 AND config_key = $2`,
    [params.tenantId, params.configKey],
  );
  const previousValue = prev.rowCount ? String(prev.rows[0].config_value) : null;

  const del = await params.pool.query(
    `DELETE FROM runtime_config_overrides WHERE tenant_id = $1 AND config_key = $2`,
    [params.tenantId, params.configKey],
  );

  if ((del.rowCount ?? 0) > 0) {
    await params.pool.query(
      `INSERT INTO config_change_audit_log (tenant_id, config_key, old_value, new_value, changed_by, change_type)
       VALUES ($1, $2, $3, NULL, $4, 'delete')`,
      [params.tenantId, params.configKey, previousValue, params.changedBy ?? ""],
    );
  }

  return { deleted: (del.rowCount ?? 0) > 0, previousValue };
}

// ---------------------------------------------------------------------------
// Resolve (with governance overrides)
// ---------------------------------------------------------------------------

/**
 * 解析指定配置项的有效值（governance → env → default）。
 */
export async function resolveConfig(params: {
  pool: Pool;
  tenantId: string;
  configKey: string;
}): Promise<ResolvedConfig> {
  const overrides = await loadConfigOverrides(params);
  return resolveRuntimeConfig(params.configKey, process.env as Record<string, string | undefined>, overrides);
}

/**
 * 解析所有 runtime-mutable 配置的有效值。
 */
export async function resolveAllConfigs(params: {
  pool: Pool;
  tenantId: string;
}): Promise<Map<string, ResolvedConfig>> {
  const overrides = await loadConfigOverrides(params);
  return resolveAllRuntimeConfigs(process.env as Record<string, string | undefined>, overrides);
}

// ---------------------------------------------------------------------------
// Audit log query
// ---------------------------------------------------------------------------

/**
 * 查询配置变更审计日志。
 */
export async function getConfigChangeAuditLog(params: {
  pool: Pool;
  tenantId: string;
  configKey?: string;
  limit?: number;
}): Promise<ConfigChangeAuditRow[]> {
  const limit = Math.min(params.limit ?? 50, 200);
  let sql = `SELECT id, config_key, old_value, new_value, changed_by, change_type, created_at
             FROM config_change_audit_log
             WHERE tenant_id = $1`;
  const binds: unknown[] = [params.tenantId];

  if (params.configKey) {
    binds.push(params.configKey);
    sql += ` AND config_key = $${binds.length}`;
  }

  sql += ` ORDER BY created_at DESC LIMIT ${limit}`;

  const res = await params.pool.query(sql, binds);
  return res.rows.map((r: any) => ({
    id: String(r.id),
    configKey: String(r.config_key),
    oldValue: r.old_value != null ? String(r.old_value) : null,
    newValue: r.new_value != null ? String(r.new_value) : null,
    changedBy: String(r.changed_by ?? ""),
    changeType: String(r.change_type) as "set" | "delete",
    createdAt: String(r.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Registry info (for UI/API)
// ---------------------------------------------------------------------------

/**
 * 返回所有 runtime-mutable 配置的注册表信息（供 admin UI）。
 */
export function getRegistryInfo(): Array<{
  envKey: string;
  valueType: string;
  defaultValue?: string;
  validValues?: string[];
  description: string;
  scopes: string[];
}> {
  return getRuntimeMutableConfigs().map((e) => ({
    envKey: e.envKey,
    valueType: e.valueType,
    defaultValue: e.defaultValue,
    validValues: e.validValues,
    description: e.description,
    scopes: [...e.scopes],
  }));
}
