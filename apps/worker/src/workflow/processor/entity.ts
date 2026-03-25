import type { Pool } from "pg";
import { compilePolicyExprWhere } from "@openslin/shared";
import { checkType, digestObject, isPlainObject } from "./common";
import { callDataPlaneJson } from "./dataPlaneGateway";

function isSafeFieldName(name: string) {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export function compileRowFiltersWhere(
  params: { rowFilters: any; subject: { subjectId: string | null; tenantId: string | null; spaceId: string | null }; context?: any },
  args: any[],
  idxStart: number,
) {
  let idx = idxStart;
  const fieldExpr = (field: string) => {
    args.push(field);
    return `(payload->>$${++idx})`;
  };
  const pushValue = (value: any) => {
    args.push(value);
    return `$${++idx}`;
  };

  const compileOne = (rf: any): string => {
    if (!rf) return "TRUE";
    if (typeof rf !== "object" || Array.isArray(rf)) throw new Error("policy_violation:unsupported_row_filters");
    const kind = String((rf as any).kind ?? "");
    if (kind === "owner_only") {
      if (!params.subject.subjectId) throw new Error("policy_violation:missing_subject_id");
      const right = pushValue(params.subject.subjectId);
      return `owner_subject_id = ${right}`;
    }
    if (kind === "payload_field_eq_subject") {
      if (!params.subject.subjectId) throw new Error("policy_violation:missing_subject_id");
      const field = String((rf as any).field ?? "");
      if (!isSafeFieldName(field)) throw new Error("policy_violation:row_filter_field_invalid");
      const left = fieldExpr(field);
      const right = pushValue(params.subject.subjectId);
      return `${left} = ${right}::text`;
    }
    if (kind === "payload_field_eq_literal") {
      const field = String((rf as any).field ?? "");
      if (!isSafeFieldName(field)) throw new Error("policy_violation:row_filter_field_invalid");
      const value = (rf as any).value;
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("policy_violation:row_filter_value_invalid");
      const left = fieldExpr(field);
      const right = pushValue(String(value));
      return `${left} = ${right}::text`;
    }
    if (kind === "or") {
      const rules = (rf as any).rules;
      if (!Array.isArray(rules) || rules.length === 0) return "TRUE";
      return `(${rules.map((x: any) => `(${compileOne(x)})`).join(" OR ")})`;
    }
    if (kind === "expr") {
      const compiled = compilePolicyExprWhere({
        expr: (rf as any).expr,
        subject: params.subject,
        context: params.context,
        args,
        idxStart: idx,
        ownerColumn: "owner_subject_id",
        payloadColumn: "payload",
      });
      idx = compiled.idx;
      return compiled.sql;
    }
    throw new Error("policy_violation:unsupported_row_filters");
  };

  const sql = compileOne(params.rowFilters);
  return { sql, idx };
}

export async function loadLatestSchema(pool: Pool, schemaName: string) {
  const res = await pool.query(
    "SELECT name, version, schema_json FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1",
    [schemaName],
  );
  if (res.rowCount === 0) return null;
  return { name: res.rows[0].name as string, version: res.rows[0].version as number, schema: res.rows[0].schema_json as any };
}

export function validateEntityPayload(schema: any, entityName: string, payload: unknown, mode: "create" | "update") {
  const entity = schema?.entities?.[entityName];
  if (!entity) throw new Error(`未知实体：${entityName}`);
  if (!isPlainObject(payload)) throw new Error("payload 必须是对象");
  const fields = entity.fields ?? {};
  if (mode === "create") {
    for (const [fieldName, def] of Object.entries<any>(fields)) {
      const v = (payload as any)[fieldName];
      if (def.required && (v === undefined || v === null)) throw new Error(`缺少必填字段：${fieldName}`);
      if (v !== undefined && !checkType(def.type, v)) throw new Error(`字段类型错误：${fieldName}`);
    }
    return;
  }

  for (const [fieldName, v] of Object.entries<any>(payload)) {
    const def = fields[fieldName];
    if (!def) throw new Error(`未知字段：${fieldName}`);
    if (!checkType(def.type, v)) throw new Error(`字段类型错误：${fieldName}`);
  }
}

function allowAll(allow: string[] | undefined) {
  return Boolean(allow?.includes("*"));
}

export function applyReadFieldRules(payload: Record<string, unknown>, fieldRules: any) {
  const allow = fieldRules?.read?.allow;
  const deny = fieldRules?.read?.deny;
  if (allowAll(allow) && (!deny || deny.length === 0)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (deny?.includes(k)) continue;
    if (allow && allow.length > 0 && !allowAll(allow) && !allow.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function applyWriteFieldRules(payload: Record<string, unknown>, fieldRules: any) {
  const allow = fieldRules?.write?.allow;
  const deny = fieldRules?.write?.deny;
  if (allowAll(allow) && (!deny || deny.length === 0)) return payload;
  const forbidden: string[] = [];
  for (const k of Object.keys(payload)) {
    if (deny?.includes(k)) forbidden.push(k);
    else if (allow && allow.length > 0 && !allowAll(allow) && !allow.includes(k)) forbidden.push(k);
  }
  if (forbidden.length > 0) throw new Error(`policy_violation:field_write_forbidden:${forbidden.join(",")}`);
  return payload;
}

export async function createArtifact(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  type: string;
  format: string;
  contentType: string;
  contentText: string;
  source?: any;
  runId?: string | null;
  stepId?: string | null;
  createdBySubjectId?: string | null;
}) {
  const byteSize = Buffer.byteLength(params.contentText ?? "", "utf8");
  const res = await params.pool.query(
    `
      INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source, run_id, step_id, created_by_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING artifact_id, byte_size
    `,
    [
      params.tenantId,
      params.spaceId,
      params.type,
      params.format,
      params.contentType,
      byteSize,
      params.contentText,
      params.source ?? null,
      params.runId ?? null,
      params.stepId ?? null,
      params.createdBySubjectId ?? null,
    ],
  );
  return { artifactId: res.rows[0].artifact_id as string, byteSize: res.rows[0].byte_size as number };
}

function compileFilters(params: { expr: any; idxStart: number; args: any[]; fieldTypes: Record<string, string> }) {
  let idx = params.idxStart;
  const args = params.args;
  const types = params.fieldTypes;

  const fieldExpr = (field: string) => {
    args.push(field);
    return `(payload->>$${++idx})`;
  };

  const typedExpr = (field: string) => {
    const base = fieldExpr(field);
    const t = types[field];
    if (t === "number") return `NULLIF(${base}, '')::numeric`;
    if (t === "datetime") return `NULLIF(${base}, '')::timestamptz`;
    if (t === "boolean") return `NULLIF(${base}, '')::boolean`;
    return base;
  };

  const pushValue = (value: any) => {
    args.push(value);
    return `$${++idx}`;
  };

  const compileCond = (e: any) => {
    const field = String(e.field ?? "");
    const op = String(e.op ?? "");
    const value = (e as any).value;
    if (!field || !op) return "TRUE";
    if (!types[field] || types[field] === "json") return "TRUE";

    if (op === "eq") {
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      if (t === "number") return `${left} = ${right}::numeric`;
      if (t === "datetime") return `${left} = ${right}::timestamptz`;
      if (t === "boolean") return `${left} = ${right}::boolean`;
      return `${left} = ${right}::text`;
    }

    if (op === "contains") {
      const left = typedExpr(field);
      const right = pushValue(String(value ?? ""));
      return `${left} ILIKE '%' || ${right}::text || '%'`;
    }

    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0) return "FALSE";
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      if (t === "number") return `${left} = ANY(${right}::numeric[])`;
      if (t === "datetime") return `${left} = ANY(${right}::timestamptz[])`;
      if (t === "boolean") return `${left} = ANY(${right}::boolean[])`;
      return `${left} = ANY(${right}::text[])`;
    }

    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      const left = typedExpr(field);
      const right = pushValue(value);
      const t = types[field];
      const opSql = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      if (t === "number") return `${left} ${opSql} ${right}::numeric`;
      if (t === "datetime") return `${left} ${opSql} ${right}::timestamptz`;
      return "TRUE";
    }

    return "TRUE";
  };

  const compile = (e: any): string => {
    if (!e) return "TRUE";
    if (e.and && Array.isArray(e.and)) return `(${e.and.map((x: any) => compile(x)).join(" AND ")})`;
    if (e.or && Array.isArray(e.or)) return `(${e.or.map((x: any) => compile(x)).join(" OR ")})`;
    return compileCond(e);
  };

  return { sql: compile(params.expr), idx, args };
}

export async function executeEntityExport(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  runId: string;
  stepId: string;
  traceId: string;
  input: any;
}) {
  const entityName = String(params.input?.entityName ?? "");
  const schemaName = String(params.input?.schemaName ?? "core");
  const format = String(params.input?.format ?? "jsonl");
  const query = params.input?.query ?? {};
  const select = Array.isArray(params.input?.select) ? (params.input.select as string[]) : null;
  const fieldRules = params.input?.fieldRules ?? null;
  const rowFilters = params.input?.rowFilters ?? null;

  if (!entityName) throw new Error("policy_violation:missing_entity");
  const schema = await loadLatestSchema(params.pool, schemaName);
  if (!schema) throw new Error(`schema_not_found:${schemaName}`);
  const entity = schema.schema?.entities?.[entityName];
  if (!entity) throw new Error("policy_violation:entity_not_found");

  const fieldTypes: Record<string, string> = {};
  for (const [k, def] of Object.entries<any>(entity.fields ?? {})) fieldTypes[k] = def.type;

  let cursor = query.cursor ?? null;
  const maxRows = 1000;
  const items: any[] = [];
  while (items.length < maxRows) {
    const args: any[] = [params.tenantId, params.spaceId, entityName];
    let idx = 3;
    const where: string[] = ["tenant_id = $1", "space_id = $2", "entity_name = $3"];
    const rf = compileRowFiltersWhere(
      {
        rowFilters,
        subject: { subjectId: params.subjectId, tenantId: params.tenantId, spaceId: params.spaceId },
        context: { request: { traceId: params.traceId, method: "ASYNC", path: "worker" }, resource: { type: `entity:${entityName}` } },
      },
      args,
      idx,
    );
    idx = rf.idx;
    if (rf.sql !== "TRUE") where.push(rf.sql);
    if (query.filters) {
      const c = compileFilters({ expr: query.filters, idxStart: idx, args, fieldTypes });
      idx = c.idx;
      where.push(c.sql);
    }
    if (cursor?.updatedAt && cursor?.id) {
      args.push(cursor.updatedAt);
      args.push(cursor.id);
      where.push(`(updated_at, id) < ($${++idx}::timestamptz, $${++idx}::uuid)`);
    }
    const pageSize = Math.min(200, maxRows - items.length);
    args.push(pageSize);
    const sql = `
      SELECT id, revision, created_at, updated_at, payload
      FROM entity_records
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${++idx}
    `;
    const res = await params.pool.query(sql, args);
    if (!res.rowCount) break;

    for (const r of res.rows) {
      const readable = applyReadFieldRules((r.payload ?? {}) as any, fieldRules);
      const picked: any = {};
      if (select && select.length) {
        for (const k of select) if (Object.prototype.hasOwnProperty.call(readable, k)) picked[k] = (readable as any)[k];
      } else {
        Object.assign(picked, readable);
      }
      items.push({
        id: r.id,
        revision: r.revision,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        payload: picked,
      });
    }
    const last = res.rows[res.rows.length - 1];
    cursor = { updatedAt: last.updated_at, id: last.id };
    if (res.rowCount < pageSize) break;
  }

  const contentText =
    format === "json"
      ? JSON.stringify(items)
      : items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : "");
  const contentType = format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8";
  const created = await createArtifact({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    type: "export",
    format,
    contentType,
    contentText,
    source: { entityName, schemaName, queryDigest: digestObject(query), selectCount: select?.length ?? 0 },
    runId: params.runId,
    stepId: params.stepId,
    createdBySubjectId: params.subjectId,
  });
  return { artifactId: created.artifactId, byteSize: created.byteSize, count: items.length, truncated: items.length >= maxRows };
}

export async function executeEntityImport(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  runId: string;
  stepId: string;
  traceId: string;
  idempotencyKey: string;
  input: any;
}) {
  const entityName = String(params.input?.entityName ?? "");
  const schemaName = String(params.input?.schemaName ?? "core");
  const format = String(params.input?.format ?? "jsonl");
  const records = Array.isArray(params.input?.records) ? (params.input.records as any[]) : [];
  const fieldRules = params.input?.fieldRules ?? null;
  if (!entityName) throw new Error("policy_violation:missing_entity");
  if (!params.idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
  if (!params.subjectId) throw new Error("policy_violation:missing_subject_id");

  const schema = await loadLatestSchema(params.pool, schemaName);
  if (!schema) throw new Error(`schema_not_found:${schemaName}`);
  const entity = schema.schema?.entities?.[entityName];
  if (!entity) throw new Error("policy_violation:entity_not_found");

  let accepted = 0;
  let rejected = 0;
  let idempotentHits = 0;
  const sampleErrors: any[] = [];
  const writtenIds: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    try {
      if (!isPlainObject(raw)) throw new Error("record_must_be_object");
      const payload = applyWriteFieldRules(raw as any, fieldRules);
      validateEntityPayload(schema.schema, entityName, payload, "create");
      const perKey = `${params.idempotencyKey}:${i}`;
      const out = await executeEntityCreate({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        ownerSubjectId: String(params.subjectId),
        idempotencyKey: perKey,
        schemaName,
        entityName,
        payload,
      });
      accepted += 1;
      if (out.idempotentHit) idempotentHits += 1;
      writtenIds.push(out.recordId);
    } catch (e: any) {
      rejected += 1;
      if (sampleErrors.length < 20) sampleErrors.push({ index: i, error: String(e?.message ?? e) });
    }
  }

  const report = { entityName, schemaName, format, acceptedCount: accepted, rejectedCount: rejected, idempotentHits, sampleErrors, writtenCount: writtenIds.length };
  const contentText = JSON.stringify(report);
  const created = await createArtifact({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    type: "import_report",
    format: "json",
    contentType: "application/json; charset=utf-8",
    contentText,
    source: { entityName, schemaName, batchDigest: digestObject({ count: records.length }), idempotencyKey: params.idempotencyKey },
    runId: params.runId,
    stepId: params.stepId,
    createdBySubjectId: params.subjectId,
  });
  return { artifactId: created.artifactId, byteSize: created.byteSize, ...report };
}

async function loadArtifactForRestore(params: { pool: Pool; tenantId: string; spaceId: string; artifactId: string }) {
  const res = await params.pool.query(
    "SELECT artifact_id, format, content_text FROM artifacts WHERE tenant_id = $1 AND space_id = $2 AND artifact_id = $3 LIMIT 1",
    [params.tenantId, params.spaceId, params.artifactId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return { artifactId: r.artifact_id as string, format: String(r.format ?? "jsonl"), contentText: String(r.content_text ?? "") };
}

export async function executeSpaceBackup(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  runId: string;
  stepId: string;
  traceId: string;
  input: any;
}) {
  const schemaName = String(params.input?.schemaName ?? "core");
  const format = String(params.input?.format ?? "jsonl");
  const entityNames = Array.isArray(params.input?.entityNames) ? (params.input.entityNames as string[]) : null;
  const fieldRules = params.input?.fieldRules ?? null;
  const rowFilters = params.input?.rowFilters ?? null;

  const schema = await loadLatestSchema(params.pool, schemaName);
  if (!schema) throw new Error(`schema_not_found:${schemaName}`);
  const allEntities = Object.keys(schema.schema?.entities ?? {});
  const targets = entityNames && entityNames.length ? entityNames : allEntities;

  const maxRows = 5000;
  const items: any[] = [];
  for (const entityName of targets) {
    if (!schema.schema?.entities?.[entityName]) continue;
    const remaining = maxRows - items.length;
    if (remaining <= 0) break;
    const args: any[] = [params.tenantId, params.spaceId, entityName];
    let idx = 3;
    const where: string[] = ["tenant_id = $1", "space_id = $2", "entity_name = $3"];
    const rf = compileRowFiltersWhere(
      {
        rowFilters,
        subject: { subjectId: params.subjectId, tenantId: params.tenantId, spaceId: params.spaceId },
        context: { request: { traceId: params.traceId, method: "ASYNC", path: "worker" }, resource: { type: `entity:${entityName}` } },
      },
      args,
      idx,
    );
    idx = rf.idx;
    if (rf.sql !== "TRUE") where.push(rf.sql);
    args.push(remaining);
    const res = await params.pool.query(
      `
        SELECT id, revision, schema_name, schema_version, created_at, updated_at, payload, owner_subject_id
        FROM entity_records
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${++idx}
      `,
      args,
    );
    for (const r of res.rows) {
      const readable = applyReadFieldRules((r.payload ?? {}) as any, fieldRules);
      items.push({
        entityName,
        id: r.id,
        revision: r.revision,
        schemaName: r.schema_name,
        schemaVersion: r.schema_version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ownerSubjectId: r.owner_subject_id ?? null,
        payload: readable,
      });
    }
  }

  const truncated = items.length >= maxRows;
  const contentText =
    format === "json"
      ? JSON.stringify(items)
      : items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : "");
  const contentType = format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8";
  const created = await createArtifact({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    type: "backup",
    format,
    contentType,
    contentText,
    source: { spaceId: params.spaceId, schemaName, entityNames: entityNames ?? null, count: items.length, truncated },
    runId: params.runId,
    stepId: params.stepId,
    createdBySubjectId: params.subjectId,
  });
  await params.pool.query(
    "UPDATE backups SET status = 'succeeded', backup_artifact_id = $3, updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
    [params.tenantId, params.runId, created.artifactId],
  );
  return { artifactId: created.artifactId, byteSize: created.byteSize, count: items.length, truncated };
}

export async function executeSpaceRestore(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  runId: string;
  stepId: string;
  traceId: string;
  input: any;
}) {
  const schemaName = String(params.input?.schemaName ?? "core");
  const backupArtifactId = String(params.input?.backupArtifactId ?? "");
  const conflictStrategy = String(params.input?.conflictStrategy ?? "fail");
  const fieldRules = params.input?.fieldRules ?? null;
  if (!backupArtifactId) throw new Error("policy_violation:missing_backup_artifact");

  const schema = await loadLatestSchema(params.pool, schemaName);
  if (!schema) throw new Error(`schema_not_found:${schemaName}`);
  const art = await loadArtifactForRestore({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, artifactId: backupArtifactId });
  if (!art) throw new Error("policy_violation:backup_artifact_not_found");

  const rows: any[] =
    art.format === "json"
      ? (JSON.parse(art.contentText || "[]") as any[])
      : art.contentText
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => JSON.parse(x));

  let accepted = 0;
  let rejected = 0;
  let conflicts = 0;
  const sampleErrors: any[] = [];

  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    try {
      const entityName = String(it.entityName ?? "");
      if (!entityName || !schema.schema?.entities?.[entityName]) throw new Error("entity_not_found");
      const payload = applyWriteFieldRules((it.payload ?? {}) as any, fieldRules);
      validateEntityPayload(schema.schema, entityName, payload, "create");
      const id = it.id ? String(it.id) : null;
      const ownerSubjectId = typeof it.ownerSubjectId === "string" ? it.ownerSubjectId : params.subjectId;

      if (id) {
        const existing = await params.pool.query("SELECT tenant_id, space_id FROM entity_records WHERE id = $1 LIMIT 1", [id]);
        if (existing.rowCount) {
          const r = existing.rows[0] as any;
          const sameScope = r.tenant_id === params.tenantId && r.space_id === params.spaceId;
          if (!sameScope) throw new Error("conflict_scope_mismatch");
          if (conflictStrategy === "fail") {
            conflicts += 1;
            throw new Error("conflict_exists");
          }
          await params.pool.query(
            `
              UPDATE entity_records
              SET payload = $4::jsonb,
                  schema_name = $5,
                  schema_version = $6,
                  revision = revision + 1,
                  updated_at = now()
              WHERE tenant_id = $1 AND space_id = $2 AND entity_name = $3 AND id = $7
            `,
            [params.tenantId, params.spaceId, entityName, payload, schema.name, schema.version, id],
          );
          accepted += 1;
          continue;
        }
      }

      if (id) {
        await params.pool.query(
          `
            INSERT INTO entity_records (id, tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,
          [id, params.tenantId, params.spaceId, entityName, schema.name, schema.version, payload, ownerSubjectId ?? null],
        );
      } else {
        await params.pool.query(
          `
            INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
          `,
          [params.tenantId, params.spaceId, entityName, schema.name, schema.version, payload, ownerSubjectId ?? null],
        );
      }
      accepted += 1;
    } catch (e: any) {
      rejected += 1;
      if (sampleErrors.length < 20) sampleErrors.push({ index: i, error: String(e?.message ?? e) });
    }
  }

  const report = { spaceId: params.spaceId, schemaName, backupArtifactId, conflictStrategy, acceptedCount: accepted, rejectedCount: rejected, conflicts, sampleErrors };
  const reportText = JSON.stringify(report);
  const created = await createArtifact({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    type: "restore_report",
    format: "json",
    contentType: "application/json; charset=utf-8",
    contentText: reportText,
    source: { spaceId: params.spaceId, schemaName, backupArtifactId, conflictStrategy },
    runId: params.runId,
    stepId: params.stepId,
    createdBySubjectId: params.subjectId,
  });
  return { artifactId: created.artifactId, byteSize: created.byteSize, ...report };
}

export async function executeEntityCreate(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  ownerSubjectId: string;
  idempotencyKey: string;
  schemaName: string;
  entityName: string;
  payload: any;
  traceId?: string;
  runId?: string | null;
  stepId?: string | null;
  policySnapshotRef?: string | null;
}) {
  const traceId = params.traceId ?? "unknown";
  const out = await callDataPlaneJson({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.ownerSubjectId,
    traceId,
    runId: params.runId ?? null,
    stepId: params.stepId ?? null,
    policySnapshotRef: params.policySnapshotRef ?? null,
    method: "POST",
    path: `/entities/${encodeURIComponent(params.entityName)}`,
    idempotencyKey: params.idempotencyKey,
    schemaName: params.schemaName,
    body: params.payload,
  });
  const recordId = String((out as any)?.recordId ?? (out as any)?.id ?? "");
  if (!recordId) throw new Error("entity_create_missing_record_id");
  return { recordId, idempotentHit: false };
}

export async function executeEntityDelete(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  ownerSubjectId: string;
  rowFilters: any;
  idempotencyKey: string;
  schemaName: string;
  entityName: string;
  id: string;
  traceId?: string;
  runId?: string | null;
  stepId?: string | null;
  policySnapshotRef?: string | null;
}) {
  const traceId = params.traceId ?? "unknown";
  const out = await callDataPlaneJson({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.ownerSubjectId,
    traceId,
    runId: params.runId ?? null,
    stepId: params.stepId ?? null,
    policySnapshotRef: params.policySnapshotRef ?? null,
    method: "DELETE",
    path: `/entities/${encodeURIComponent(params.entityName)}/${encodeURIComponent(params.id)}`,
    idempotencyKey: params.idempotencyKey,
    schemaName: params.schemaName,
    body: {},
  });
  const recordId = String((out as any)?.recordId ?? (out as any)?.id ?? params.id);
  const deleted = typeof (out as any)?.deleted === "boolean" ? Boolean((out as any).deleted) : true;
  return { recordId, idempotentHit: false, deleted };
}

export async function executeEntityUpdate(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  ownerSubjectId: string;
  rowFilters: any;
  idempotencyKey: string;
  schemaName: string;
  entityName: string;
  id: string;
  patch: any;
  expectedRevision?: number;
  traceId?: string;
  runId?: string | null;
  stepId?: string | null;
  policySnapshotRef?: string | null;
}) {
  const traceId = params.traceId ?? "unknown";
  const out = await callDataPlaneJson({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.ownerSubjectId,
    traceId,
    runId: params.runId ?? null,
    stepId: params.stepId ?? null,
    policySnapshotRef: params.policySnapshotRef ?? null,
    method: "PATCH",
    path: `/entities/${encodeURIComponent(params.entityName)}/${encodeURIComponent(params.id)}`,
    idempotencyKey: params.idempotencyKey,
    schemaName: params.schemaName,
    body: params.patch,
  });
  const recordId = String((out as any)?.recordId ?? (out as any)?.id ?? params.id);
  if (!recordId) throw new Error("entity_update_missing_record_id");
  return { recordId, idempotentHit: false };
}

export async function executeEntityQuery(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  traceId: string;
  runId?: string | null;
  stepId?: string | null;
  policySnapshotRef?: string | null;
  schemaName: string;
  entityName: string;
  query: any;
}) {
  const out = await callDataPlaneJson({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    traceId: params.traceId,
    runId: params.runId ?? null,
    stepId: params.stepId ?? null,
    policySnapshotRef: params.policySnapshotRef ?? null,
    method: "POST",
    path: `/entities/${encodeURIComponent(params.entityName)}/query`,
    schemaName: params.schemaName,
    body: { schemaName: params.schemaName, ...(params.query ?? {}) },
  });
  return out;
}
