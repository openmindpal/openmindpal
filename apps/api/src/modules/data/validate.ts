import type { SchemaDef } from "../metadata/schemaModel";
import type { Pool, PoolClient } from "pg";

type ValidationError = { ok: false; reason: string };
type ValidationOk = { ok: true };

export type ValidationResult = ValidationOk | ValidationError;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function checkType(type: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string";
    case "json":
      return true;
    case "reference":
      return typeof value === "string";
    default:
      return false;
  }
}

export function validateEntityPayload(params: {
  schema: SchemaDef;
  entityName: string;
  payload: unknown;
}): ValidationResult {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return { ok: false, reason: `未知实体：${params.entityName}` };
  if (!isPlainObject(params.payload)) return { ok: false, reason: "payload 必须是对象" };

  const fields = entity.fields ?? {};
  for (const [fieldName, def] of Object.entries(fields)) {
    const v = (params.payload as any)[fieldName];
    if (def.required && (v === undefined || v === null)) {
      return { ok: false, reason: `缺少必填字段：${fieldName}` };
    }
    if (v !== undefined && !checkType(def.type, v)) {
      return { ok: false, reason: `字段类型错误：${fieldName}` };
    }
  }

  return { ok: true };
}

/**
 * Validate that all reference fields point to existing entity_records.
 * Called during create/update to enforce referential integrity.
 */
export async function validateReferenceFields(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string | null;
  schema: SchemaDef;
  entityName: string;
  payload: Record<string, unknown>;
}): Promise<ValidationResult> {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return { ok: true };
  const fields = entity.fields ?? {};
  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.type !== "reference") continue;
    const refEntity = (def as any).referenceEntity;
    if (!refEntity) continue;
    const value = params.payload[fieldName];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return { ok: false, reason: `字段 ${fieldName} 必须是字符串（引用 ID）` };
    const res = await params.pool.query(
      "SELECT 1 FROM entity_records WHERE tenant_id = $1 AND ($2::text IS NULL OR space_id = $2) AND entity_name = $3 AND id = $4::uuid LIMIT 1",
      [params.tenantId, params.spaceId ?? null, refEntity, value],
    );
    if (!res.rowCount) {
      return { ok: false, reason: `字段 ${fieldName} 引用的 ${refEntity} 记录不存在：${value}` };
    }
  }
  return { ok: true };
}

