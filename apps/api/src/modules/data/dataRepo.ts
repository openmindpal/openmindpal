import type { Pool, PoolClient } from "pg";
import { compilePolicyExprWhere, validatePolicyExpr } from "@openslin/shared";

export type EntityRecord = {
  id: string;
  tenantId: string;
  spaceId: string | null;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  payload: any;
  ownerSubjectId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

function rowToRecord(r: any): EntityRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    entityName: r.entity_name,
    schemaName: r.schema_name,
    schemaVersion: r.schema_version,
    payload: r.payload,
    ownerSubjectId: r.owner_subject_id ?? null,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isSafeFieldName(name: string) {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

const policyExprValidatedCache = new Map<string, { expr: any; usedPayloadPaths: string[] }>();

function compileRowFiltersWhere(
  params: { rowFilters?: any; subject: { subjectId?: string | null; tenantId?: string | null; spaceId?: string | null }; context?: any },
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
      const subjectId = params.subject.subjectId ?? null;
      if (!subjectId) throw new Error("policy_violation:missing_subject_id");
      const right = pushValue(subjectId);
      return `owner_subject_id = ${right}`;
    }
    if (kind === "payload_field_eq_subject") {
      const subjectId = params.subject.subjectId ?? null;
      if (!subjectId) throw new Error("policy_violation:missing_subject_id");
      const field = String((rf as any).field ?? "");
      if (!isSafeFieldName(field)) throw new Error("policy_violation:row_filter_field_invalid");
      const left = fieldExpr(field);
      const right = pushValue(subjectId);
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
    if (kind === "and") {
      const rules = (rf as any).rules;
      if (!Array.isArray(rules) || rules.length === 0) return "TRUE";
      return `(${rules.map((x: any) => `(${compileOne(x)})`).join(" AND ")})`;
    }
    if (kind === "not") {
      const rule = (rf as any).rule;
      if (!rule) return "TRUE";
      return `(NOT (${compileOne(rule)}))`;
    }
    if (kind === "space_member") {
      const subjectId = params.subject.subjectId ?? null;
      const spaceId = params.subject.spaceId ?? null;
      const tenantId = params.subject.tenantId ?? null;
      if (!subjectId || !tenantId) throw new Error("policy_violation:missing_subject_id");
      const roles = (rf as any).roles;
      if (Array.isArray(roles) && roles.length > 0) {
        const tParam = pushValue(tenantId);
        const sParam = pushValue(subjectId);
        const rParam = pushValue(roles);
        return `EXISTS (SELECT 1 FROM space_members sm WHERE sm.tenant_id = ${tParam} AND sm.subject_id = ${sParam} AND sm.space_id = COALESCE(entity_records.space_id, '') AND sm.role = ANY(${rParam}::text[]))`;
      }
      const tParam = pushValue(tenantId);
      const sParam = pushValue(subjectId);
      return `EXISTS (SELECT 1 FROM space_members sm WHERE sm.tenant_id = ${tParam} AND sm.subject_id = ${sParam} AND sm.space_id = COALESCE(entity_records.space_id, ''))`;
    }
    if (kind === "org_hierarchy") {
      const orgField = String((rf as any).orgField ?? "orgUnitId");
      if (!isSafeFieldName(orgField)) throw new Error("policy_violation:row_filter_field_invalid");
      const includeDescendants = Boolean((rf as any).includeDescendants ?? true);
      const subjectId = params.subject.subjectId ?? null;
      const tenantId = params.subject.tenantId ?? null;
      if (!subjectId || !tenantId) throw new Error("policy_violation:missing_subject_id");
      const recordOrgExpr = fieldExpr(orgField);
      const tParam = pushValue(tenantId);
      const sParam = pushValue(subjectId);
      if (includeDescendants) {
        return `EXISTS (SELECT 1 FROM subject_org_assignments soa JOIN org_units ou ON ou.org_unit_id = soa.org_unit_id JOIN org_units target_ou ON target_ou.org_unit_id::text = ${recordOrgExpr} WHERE soa.tenant_id = ${tParam} AND soa.subject_id = ${sParam} AND target_ou.org_path LIKE ou.org_path || '%')`;
      }
      return `EXISTS (SELECT 1 FROM subject_org_assignments soa WHERE soa.tenant_id = ${tParam} AND soa.subject_id = ${sParam} AND soa.org_unit_id::text = ${recordOrgExpr})`;
    }
    if (kind === "expr") {
      const epochKey = JSON.stringify(params.context?.policyCacheEpoch ?? null);
      const exprRaw = (rf as any).expr ?? null;
      const exprKey = `${epochKey}|${JSON.stringify(exprRaw)}`;
      let validated = policyExprValidatedCache.get(exprKey);
      if (!validated) {
        const v = validatePolicyExpr(exprRaw);
        if (!v.ok) throw new Error("policy_violation:policy_expr_invalid");
        validated = { expr: v.expr as any, usedPayloadPaths: v.usedPayloadPaths };
        policyExprValidatedCache.set(exprKey, validated);
        if (policyExprValidatedCache.size > 500) {
          const first = policyExprValidatedCache.keys().next().value;
          if (first) policyExprValidatedCache.delete(first);
        }
      }
      const compiled = compilePolicyExprWhere({
        expr: exprRaw,
        validated,
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

export async function listRecords(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  limit: number;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3"];
  let idx = 3;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM entity_records
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${++idx}
    `,
    args,
  );
  return res.rows.map(rowToRecord);
}

export async function getRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName, params.id];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3", "id = $4"];
  let idx = 4;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      SELECT *
      FROM entity_records
      WHERE ${where.join(" AND ")}
      LIMIT 1
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

export async function insertRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  payload: any;
  ownerSubjectId: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.entityName,
      params.schemaName,
      params.schemaVersion,
      params.payload,
      params.ownerSubjectId,
    ],
  );
  return rowToRecord(res.rows[0]);
}

export async function updateRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  patch: any;
  expectedRevision?: number;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [
    params.tenantId,
    params.spaceId ?? null,
    params.entityName,
    params.id,
    params.patch,
    params.expectedRevision ?? null,
  ];
  const where: string[] = [
    "tenant_id = $1",
    "($2::text IS NULL OR space_id = $2)",
    "entity_name = $3",
    "id = $4",
    "($6::int IS NULL OR revision = $6)",
  ];
  let idx = 6;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      UPDATE entity_records
      SET payload = payload || $5::jsonb,
          revision = revision + 1,
          updated_at = now()
      WHERE ${where.join(" AND ")}
      RETURNING *
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

export async function deleteRecord(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  id: string;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName, params.id];
  const where: string[] = ["tenant_id = $1", "($2::text IS NULL OR space_id = $2)", "entity_name = $3", "id = $4"];
  let idx = 4;
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);
  const res = await params.pool.query(
    `
      DELETE FROM entity_records
      WHERE ${where.join(" AND ")}
      RETURNING *
    `,
    args,
  );
  if (res.rowCount === 0) return null;
  return rowToRecord(res.rows[0]);
}

function compileFilters(params: {
  expr: any;
  idxStart: number;
  args: any[];
  fieldTypes: Record<string, string>;
}) {
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
      if (!Array.isArray(value) || value.length === 0) throw new Error("in_value_invalid");
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

export async function queryRecords(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  spaceId?: string;
  entityName: string;
  limit: number;
  filters?: any;
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  cursor?: { updatedAt: string; id: string };
  select?: string[];
  fieldTypes: Record<string, string>;
  subjectId?: string;
  rowFilters?: any;
  policyContext?: any;
}) {
  const args: any[] = [params.tenantId, params.spaceId ?? null, params.entityName];
  let idx = 3;
  const where: string[] = [
    "tenant_id = $1",
    "($2::text IS NULL OR space_id = $2)",
    "entity_name = $3",
  ];
  const rf = compileRowFiltersWhere(
    { rowFilters: params.rowFilters, subject: { subjectId: params.subjectId ?? null, tenantId: params.tenantId, spaceId: params.spaceId ?? null }, context: params.policyContext ?? null },
    args,
    idx,
  );
  idx = rf.idx;
  if (rf.sql !== "TRUE") where.push(rf.sql);

  if (params.filters) {
    const c = compileFilters({ expr: params.filters, idxStart: idx, args, fieldTypes: params.fieldTypes });
    idx = c.idx;
    where.push(c.sql);
  }

  const order = params.orderBy && params.orderBy.length ? params.orderBy : [{ field: "updatedAt", direction: "desc" as const }];
  const orderSql = order
    .map((o) => {
      if (o.field === "updatedAt") return `updated_at ${o.direction.toUpperCase()}`;
      if (o.field === "createdAt") return `created_at ${o.direction.toUpperCase()}`;
      if (o.field === "id") return `id ${o.direction.toUpperCase()}`;
      const t = params.fieldTypes[o.field];
      args.push(o.field);
      const base = `(payload->>$${++idx})`;
      const expr =
        t === "number"
          ? `NULLIF(${base}, '')::numeric`
          : t === "datetime"
            ? `NULLIF(${base}, '')::timestamptz`
            : t === "boolean"
              ? `NULLIF(${base}, '')::boolean`
              : base;
      return `${expr} ${o.direction.toUpperCase()}`;
    })
    .join(", ");

  if (params.cursor) {
    args.push(params.cursor.updatedAt);
    args.push(params.cursor.id);
    where.push(`(updated_at, id) < ($${++idx}::timestamptz, $${++idx}::uuid)`);
  }

  args.push(params.limit + 1);
  const sql = `
    SELECT *
    FROM entity_records
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderSql}, id DESC
    LIMIT $${++idx}
  `;

  const res = await params.pool.query(sql, args);
  const rows = res.rows.map(rowToRecord);
  const hasMore = rows.length > params.limit;
  const items = hasMore ? rows.slice(0, params.limit) : rows;
  const last = items.length ? items[items.length - 1] : null;
  const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  return { items, nextCursor };
}
