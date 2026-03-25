import type { Pool, PoolClient } from "pg";

/**
 * Schema Lazy Migration (架构 §6 惰性迁移)
 *
 * On read/write of entity records, detect schema version mismatch and
 * apply field-level migration patches automatically.
 * Records store `schema_version`; when effective schema version > record version,
 * we compute a migration patch (add defaults for new fields, drop removed fields)
 * and apply inline.
 */

export type LazyMigrationLogEntry = {
  logId: string;
  tenantId: string;
  schemaName: string;
  recordId: string;
  fromVersion: number;
  toVersion: number;
  migrationKind: "lazy_read" | "lazy_write";
  patchApplied: any;
  migratedAt: string;
};

function toLogEntry(r: any): LazyMigrationLogEntry {
  return {
    logId: r.log_id,
    tenantId: r.tenant_id,
    schemaName: r.schema_name,
    recordId: r.record_id,
    fromVersion: Number(r.from_version),
    toVersion: Number(r.to_version),
    migrationKind: r.migration_kind === "lazy_write" ? "lazy_write" : "lazy_read",
    patchApplied: r.patch_applied ?? null,
    migratedAt: r.migrated_at,
  };
}

/**
 * Given old field defs and new field defs, compute a JSON patch to migrate a payload.
 * - Added fields → insert default value
 * - Removed fields → remove from payload
 * - Type change → attempt coercion or null
 */
export function computeMigrationPatch(params: {
  oldFields: Record<string, { type?: string; default?: any }>;
  newFields: Record<string, { type?: string; default?: any }>;
  currentPayload: Record<string, any>;
}): { patch: Record<string, any>; removals: string[] } {
  const patch: Record<string, any> = {};
  const removals: string[] = [];

  // Added fields: present in new but not in old (or not in current payload)
  for (const [key, def] of Object.entries(params.newFields)) {
    if (!(key in params.oldFields) && !(key in params.currentPayload)) {
      patch[key] = def.default ?? defaultForType(def.type);
    }
  }

  // Removed fields: present in old but not in new
  for (const key of Object.keys(params.oldFields)) {
    if (!(key in params.newFields) && key in params.currentPayload) {
      removals.push(key);
    }
  }

  // Type changes: field exists in both but type changed
  for (const [key, newDef] of Object.entries(params.newFields)) {
    if (key in params.oldFields && key in params.currentPayload) {
      const oldType = params.oldFields[key].type;
      const newType = newDef.type;
      if (oldType !== newType && newType) {
        const coerced = coerceValue(params.currentPayload[key], newType);
        if (coerced !== undefined) {
          patch[key] = coerced;
        }
      }
    }
  }

  return { patch, removals };
}

function defaultForType(type?: string): any {
  if (!type) return null;
  switch (type) {
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return null;
  }
}

function coerceValue(value: any, targetType: string): any {
  if (value === null || value === undefined) return defaultForType(targetType);
  switch (targetType) {
    case "string": return String(value);
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case "boolean": return Boolean(value);
    default: return undefined; // can't coerce
  }
}

/**
 * Apply lazy migration to a record's payload if its schema_version < current effective version.
 * Returns the migrated payload and the patch applied, or null if no migration needed.
 */
export async function applyLazyMigrationOnRead(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  record: { id: string; schemaName: string; schemaVersion: number; payload: any };
  currentSchemaVersion: number;
  oldFields: Record<string, { type?: string; default?: any }>;
  newFields: Record<string, { type?: string; default?: any }>;
}): Promise<{ migrated: boolean; payload: any; patch?: Record<string, any> }> {
  if (params.record.schemaVersion >= params.currentSchemaVersion) {
    return { migrated: false, payload: params.record.payload };
  }

  const { patch, removals } = computeMigrationPatch({
    oldFields: params.oldFields,
    newFields: params.newFields,
    currentPayload: params.record.payload ?? {},
  });

  const hasPatch = Object.keys(patch).length > 0 || removals.length > 0;
  if (!hasPatch) {
    return { migrated: false, payload: params.record.payload };
  }

  // Build migrated payload
  const migratedPayload = { ...params.record.payload, ...patch };
  for (const key of removals) {
    delete migratedPayload[key];
  }

  // Persist the migration (async, best-effort for read path)
  try {
    await params.pool.query(
      `UPDATE entity_records SET payload=$1, schema_version=$2, updated_at=now()
       WHERE tenant_id=$3 AND id=$4 AND schema_version < $2`,
      [JSON.stringify(migratedPayload), params.currentSchemaVersion, params.tenantId, params.record.id],
    );

    await logLazyMigration({
      pool: params.pool,
      tenantId: params.tenantId,
      schemaName: params.record.schemaName,
      recordId: params.record.id,
      fromVersion: params.record.schemaVersion,
      toVersion: params.currentSchemaVersion,
      migrationKind: "lazy_read",
      patchApplied: { patch, removals },
    });
  } catch {
    // Non-fatal on read path; return migrated payload anyway
  }

  return { migrated: true, payload: migratedPayload, patch };
}

/**
 * Apply lazy migration on the write path (before updating).
 * This ensures the patch is persisted atomically with the write.
 */
export function applyLazyMigrationOnWritePayload(params: {
  currentPayload: Record<string, any>;
  writePayload: Record<string, any>;
  currentSchemaVersion: number;
  recordSchemaVersion: number;
  oldFields: Record<string, { type?: string; default?: any }>;
  newFields: Record<string, { type?: string; default?: any }>;
}): { mergedPayload: Record<string, any>; migrationPatch: Record<string, any> | null } {
  if (params.recordSchemaVersion >= params.currentSchemaVersion) {
    return { mergedPayload: { ...params.currentPayload, ...params.writePayload }, migrationPatch: null };
  }

  const { patch, removals } = computeMigrationPatch({
    oldFields: params.oldFields,
    newFields: params.newFields,
    currentPayload: params.currentPayload,
  });

  const merged = { ...params.currentPayload, ...patch, ...params.writePayload };
  for (const key of removals) {
    if (!(key in params.writePayload)) {
      delete merged[key];
    }
  }

  return {
    mergedPayload: merged,
    migrationPatch: Object.keys(patch).length > 0 || removals.length > 0 ? { patch, removals } : null,
  };
}

// ─── Migration Log ──────────────────────────────────────────────────────────

export async function logLazyMigration(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  schemaName: string;
  recordId: string;
  fromVersion: number;
  toVersion: number;
  migrationKind: "lazy_read" | "lazy_write";
  patchApplied: any;
}): Promise<void> {
  await params.pool.query(
    `INSERT INTO schema_lazy_migration_log (tenant_id, schema_name, record_id, from_version, to_version, migration_kind, patch_applied)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.tenantId,
      params.schemaName,
      params.recordId,
      params.fromVersion,
      params.toVersion,
      params.migrationKind,
      JSON.stringify(params.patchApplied ?? null),
    ],
  );
}

export async function listLazyMigrationLogs(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  schemaName?: string;
  recordId?: string;
  limit?: number;
}): Promise<LazyMigrationLogEntry[]> {
  const args: any[] = [params.tenantId];
  let where = "tenant_id=$1";
  if (params.schemaName) {
    args.push(params.schemaName);
    where += ` AND schema_name=$${args.length}`;
  }
  if (params.recordId) {
    args.push(params.recordId);
    where += ` AND record_id=$${args.length}`;
  }
  const limit = Math.min(params.limit ?? 100, 500);
  args.push(limit);
  const res = await params.pool.query(
    `SELECT * FROM schema_lazy_migration_log WHERE ${where} ORDER BY migrated_at DESC LIMIT $${args.length}`,
    args,
  );
  return res.rows.map(toLogEntry);
}

export async function getMigrationStats(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  schemaName: string;
}): Promise<{ total: number; byKind: Record<string, number> }> {
  const res = await params.pool.query(
    `SELECT migration_kind, COUNT(*)::int AS c FROM schema_lazy_migration_log WHERE tenant_id=$1 AND schema_name=$2 GROUP BY migration_kind`,
    [params.tenantId, params.schemaName],
  );
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of res.rows) {
    const count = Number((r as any).c ?? 0);
    byKind[String((r as any).migration_kind)] = count;
    total += count;
  }
  return { total, byKind };
}
