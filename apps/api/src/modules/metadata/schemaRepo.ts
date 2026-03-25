import type { Pool, PoolClient } from "pg";
import type { SchemaDef } from "./schemaModel";

type Q = Pool | PoolClient;
type EffectiveScope = { tenantId: string; spaceId?: string; name: string };

export type StoredSchema = {
  id: string;
  name: string;
  version: number;
  status: "draft" | "released" | "deprecated";
  schema: SchemaDef;
  createdAt: string;
  publishedAt: string | null;
};

const DEFAULT_ALLOWED_EXTENSION_NAMESPACES = ["io.openslin.*", "org.openslin.*"];
const NAMESPACE_KEY_RE = /^[a-z][a-z0-9]*(?:[._-]?[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[._-]?[a-z0-9]+)*)+$/;
const resolvedVersionCache = new Map<string, number | null>();
const effectiveSchemaCache = new Map<string, StoredSchema | null>();
const schemaCacheVersionMap = new Map<string, number>();
let schemaCacheVersionSeq = 1;

function scopeCacheKey(params: EffectiveScope) {
  return `tenant:${params.tenantId}|space:${params.spaceId ?? "-"}|name:${params.name}`;
}

function parseScopeCacheKey(cacheKey: string): EffectiveScope | null {
  const m = /^tenant:(.+)\|space:(.*)\|name:(.+)$/.exec(cacheKey);
  if (!m) return null;
  return {
    tenantId: m[1],
    spaceId: m[2] && m[2] !== "-" ? m[2] : undefined,
    name: m[3],
  };
}

function versionMapGlobalKey(name: string) {
  return `global|${name}`;
}

function versionMapTenantKey(tenantId: string, name: string) {
  return `tenant:${tenantId}|${name}`;
}

function versionMapSpaceKey(tenantId: string, spaceId: string, name: string) {
  return `space:${tenantId}|${spaceId}|${name}`;
}

function matchesScope(params: EffectiveScope, target: { tenantId?: string; spaceId?: string; name: string }) {
  if (params.name !== target.name) return false;
  if (target.tenantId && params.tenantId !== target.tenantId) return false;
  if (target.spaceId !== undefined) return params.spaceId === target.spaceId;
  return true;
}

function bumpSchemaCacheVersion(params: { name: string; tenantId?: string; spaceId?: string }) {
  const next = ++schemaCacheVersionSeq;
  if (params.spaceId && params.tenantId) {
    schemaCacheVersionMap.set(versionMapSpaceKey(params.tenantId, params.spaceId, params.name), next);
  } else if (params.tenantId) {
    schemaCacheVersionMap.set(versionMapTenantKey(params.tenantId, params.name), next);
  } else {
    schemaCacheVersionMap.set(versionMapGlobalKey(params.name), next);
  }

  for (const key of resolvedVersionCache.keys()) {
    const scope = parseScopeCacheKey(key);
    if (!scope) continue;
    if (matchesScope(scope, params)) resolvedVersionCache.delete(key);
  }
  for (const key of effectiveSchemaCache.keys()) {
    const scope = parseScopeCacheKey(key);
    if (!scope) continue;
    if (matchesScope(scope, params)) effectiveSchemaCache.delete(key);
  }
}

export function getSchemaEffectiveCacheVersion(params: EffectiveScope) {
  return Math.max(
    schemaCacheVersionMap.get(versionMapGlobalKey(params.name)) ?? 0,
    schemaCacheVersionMap.get(versionMapTenantKey(params.tenantId, params.name)) ?? 0,
    params.spaceId ? schemaCacheVersionMap.get(versionMapSpaceKey(params.tenantId, params.spaceId, params.name)) ?? 0 : 0,
  );
}

function normalizeAllowedNamespaces() {
  const raw = String(process.env.SCHEMA_EXTENSION_NAMESPACES ?? "").trim();
  const list = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_EXTENSION_NAMESPACES;
  return Array.from(new Set(list));
}

function namespaceAllowed(namespaceKey: string, allowList: string[]) {
  return allowList.some((rule) => {
    if (rule.endsWith(".*")) {
      const prefix = rule.slice(0, -2);
      return namespaceKey === prefix || namespaceKey.startsWith(`${prefix}.`);
    }
    return namespaceKey === rule;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function validateSchemaExtensionNamespaces(schemaLike: unknown): { ok: true } | { ok: false; reason: string } {
  const allowList = normalizeAllowedNamespaces();
  const visit = (node: unknown, path: string): { ok: true } | { ok: false; reason: string } => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const out = visit(node[i], `${path}[${i}]`);
        if (!out.ok) return out;
      }
      return { ok: true };
    }
    if (!isPlainObject(node)) return { ok: true };

    const ext = (node as any).extensions;
    if (ext !== undefined) {
      if (!isPlainObject(ext)) return { ok: false, reason: `${path}.extensions 必须是对象` };
      for (const namespaceKey of Object.keys(ext)) {
        if (!NAMESPACE_KEY_RE.test(namespaceKey)) {
          return { ok: false, reason: `${path}.extensions.${namespaceKey} 不是合法命名空间` };
        }
        if (!namespaceAllowed(namespaceKey, allowList)) {
          return { ok: false, reason: `${path}.extensions.${namespaceKey} 不在允许列表` };
        }
      }
    }

    for (const [k, v] of Object.entries(node)) {
      const out = visit(v, `${path}.${k}`);
      if (!out.ok) return out;
    }
    return { ok: true };
  };

  return visit(schemaLike, "schema");
}

function rowToStored(row: any): StoredSchema {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    schema: row.schema_json,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export async function getLatestReleased(pool: Q, name: string): Promise<StoredSchema | null> {
  const res = await pool.query(
    "SELECT * FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1",
    [name],
  );
  if (res.rowCount === 0) return null;
  return rowToStored(res.rows[0]);
}

export async function getByNameVersion(
  pool: Q,
  name: string,
  version: number,
): Promise<StoredSchema | null> {
  const res = await pool.query("SELECT * FROM schemas WHERE name = $1 AND version = $2 LIMIT 1", [
    name,
    version,
  ]);
  if (res.rowCount === 0) return null;
  return rowToStored(res.rows[0]);
}

export async function listLatestReleased(pool: Q): Promise<StoredSchema[]> {
  const res = await pool.query(
    "SELECT DISTINCT ON (name) * FROM schemas WHERE status = 'released' ORDER BY name, version DESC",
  );
  return res.rows.map(rowToStored);
}

export async function listVersionsByName(params: { pool: Q; name: string; limit: number }): Promise<StoredSchema[]> {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query("SELECT * FROM schemas WHERE name = $1 ORDER BY version DESC LIMIT $2", [params.name, limit]);
  return res.rows.map(rowToStored);
}

export async function publishNewReleased(pool: Q, schema: SchemaDef): Promise<StoredSchema> {
  const nsValidation = validateSchemaExtensionNamespaces(schema);
  if (!nsValidation.ok) throw new Error(`schema_extension_namespace_invalid:${nsValidation.reason}`);
  const latest = await getLatestReleased(pool, schema.name);
  const nextVersion = (latest?.version ?? 0) + 1;

  schema.version = nextVersion;
  const res = await pool.query(
    "INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, $2, 'released', $3, now()) RETURNING *",
    [schema.name, nextVersion, schema],
  );
  bumpSchemaCacheVersion({ name: schema.name });
  return rowToStored(res.rows[0]);
}

export async function getActiveSchemaVersion(params: { pool: Pool; tenantId: string; name: string }) {
  const res = await params.pool.query(
    "SELECT active_version FROM schema_active_versions WHERE tenant_id = $1 AND name = $2 LIMIT 1",
    [params.tenantId, params.name],
  );
  if (!res.rowCount) return null;
  const v = Number(res.rows[0].active_version);
  return Number.isFinite(v) ? v : null;
}

export async function setActiveSchemaVersion(params: { pool: Q; tenantId: string; name: string; version: number }) {
  await params.pool.query(
    `
      INSERT INTO schema_active_versions (tenant_id, name, active_version)
      VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, name)
      DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
    `,
    [params.tenantId, params.name, params.version],
  );
  bumpSchemaCacheVersion({ tenantId: params.tenantId, name: params.name });
}

export async function clearActiveSchemaVersion(params: { pool: Q; tenantId: string; name: string }) {
  await params.pool.query("DELETE FROM schema_active_versions WHERE tenant_id = $1 AND name = $2", [params.tenantId, params.name]);
  bumpSchemaCacheVersion({ tenantId: params.tenantId, name: params.name });
}

export async function getActiveSchemaOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string }) {
  const res = await params.pool.query(
    "SELECT active_version FROM schema_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND name = $3 LIMIT 1",
    [params.tenantId, params.spaceId, params.name],
  );
  if (!res.rowCount) return null;
  const v = Number(res.rows[0].active_version);
  return Number.isFinite(v) ? v : null;
}

export async function setActiveSchemaOverride(params: { pool: Q; tenantId: string; spaceId: string; name: string; version: number }) {
  await params.pool.query(
    `
      INSERT INTO schema_active_overrides (tenant_id, space_id, name, active_version)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, space_id, name)
      DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
    `,
    [params.tenantId, params.spaceId, params.name, params.version],
  );
  bumpSchemaCacheVersion({ tenantId: params.tenantId, spaceId: params.spaceId, name: params.name });
}

export async function clearActiveSchemaOverride(params: { pool: Q; tenantId: string; spaceId: string; name: string }) {
  await params.pool.query("DELETE FROM schema_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND name = $3", [
    params.tenantId,
    params.spaceId,
    params.name,
  ]);
  bumpSchemaCacheVersion({ tenantId: params.tenantId, spaceId: params.spaceId, name: params.name });
}

export async function resolveEffectiveSchemaVersion(params: { pool: Pool; tenantId: string; spaceId?: string; name: string }) {
  const cacheKey = scopeCacheKey(params);
  const cached = resolvedVersionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (params.spaceId) {
    const ov = await getActiveSchemaOverride({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, name: params.name });
    if (ov) {
      resolvedVersionCache.set(cacheKey, ov);
      return ov;
    }
  }
  const v = await getActiveSchemaVersion({ pool: params.pool, tenantId: params.tenantId, name: params.name });
  resolvedVersionCache.set(cacheKey, v);
  return v;
}

export async function getEffectiveSchema(params: { pool: Pool; tenantId: string; spaceId?: string; name: string }) {
  const cacheKey = scopeCacheKey(params);
  const cached = effectiveSchemaCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const v = await resolveEffectiveSchemaVersion(params);
  const out = v ? await getByNameVersion(params.pool, params.name, v) : await getLatestReleased(params.pool, params.name);
  effectiveSchemaCache.set(cacheKey, out);
  return out;
}

export async function getPreviousReleasedSchemaVersion(params: { pool: Pool; name: string; beforeVersion: number }) {
  const res = await params.pool.query(
    "SELECT version FROM schemas WHERE name = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1",
    [params.name, params.beforeVersion],
  );
  if (!res.rowCount) return null;
  const v = Number(res.rows[0].version);
  return Number.isFinite(v) ? v : null;
}
