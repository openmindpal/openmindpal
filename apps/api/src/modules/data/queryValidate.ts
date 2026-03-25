import type { PolicyDecision } from "@openslin/shared";
import type { SchemaDef } from "../metadata/schemaModel";
import type { EntityQueryRequest } from "./queryModel";

function allowAll(allow: string[] | undefined) {
  return Boolean(allow?.includes("*"));
}

function isReadableField(field: string, decision: PolicyDecision) {
  if (field === "updatedAt" || field === "createdAt" || field === "id") return true;
  const allow = decision.fieldRules?.read?.allow;
  const deny = decision.fieldRules?.read?.deny ?? [];
  if (deny.includes(field)) return false;
  if (!allow || allow.length === 0) return true;
  if (allowAll(allow)) return true;
  return allow.includes(field);
}

function getFieldType(schema: SchemaDef, entityName: string, field: string) {
  const e = schema.entities?.[entityName];
  const f = e?.fields?.[field];
  return f?.type ?? null;
}

function assertTypeCompatible(op: string, fieldType: string | null, value: any) {
  if (!fieldType) throw new Error("字段不存在");
  if (fieldType === "json") throw new Error("json 字段不支持过滤/排序");
  if (op === "contains") {
    if (fieldType !== "string" && fieldType !== "reference") throw new Error("contains 仅支持 string/reference");
    if (typeof value !== "string") throw new Error("contains 的 value 必须为 string");
    return;
  }
  if (op === "in") {
    if (!Array.isArray(value)) throw new Error("in 的 value 必须为数组");
    if (fieldType === "number" && value.some((v) => typeof v !== "number")) throw new Error("number 字段 in value 必须为 number[]");
    if (fieldType === "datetime" && value.some((v) => typeof v !== "string")) throw new Error("datetime 字段 in value 必须为 string[]");
    if (fieldType === "boolean" && value.some((v) => typeof v !== "boolean")) throw new Error("boolean 字段 in value 必须为 boolean[]");
    if (fieldType === "string" && value.some((v) => typeof v !== "string")) throw new Error("string 字段 in value 必须为 string[]");
    if (fieldType === "reference" && value.some((v) => typeof v !== "string")) throw new Error("reference 字段 in value 必须为 string[]");
    return;
  }
  if (["gt", "gte", "lt", "lte"].includes(op)) {
    if (fieldType !== "number" && fieldType !== "datetime") throw new Error("比较运算仅支持 number/datetime");
    if (fieldType === "number" && typeof value !== "number") throw new Error("number 字段比较 value 必须为 number");
    if (fieldType === "datetime" && typeof value !== "string") throw new Error("datetime 字段比较 value 必须为 string");
    return;
  }
  if (op === "eq") {
    if (fieldType === "number" && typeof value !== "number") throw new Error("number 字段 eq value 必须为 number");
    if (fieldType === "datetime" && typeof value !== "string") throw new Error("datetime 字段 eq value 必须为 string");
    if (fieldType === "boolean" && typeof value !== "boolean") throw new Error("boolean 字段 eq value 必须为 boolean");
    if (fieldType === "string" && typeof value !== "string") throw new Error("string 字段 eq value 必须为 string");
    if (fieldType === "reference" && typeof value !== "string") throw new Error("reference 字段 eq value 必须为 string");
  }
}

function walkFilters(expr: any, visitCond: (cond: { field: string; op: string; value: any }) => void) {
  if (!expr) return;
  if (expr.and && Array.isArray(expr.and)) {
    for (const it of expr.and) walkFilters(it, visitCond);
    return;
  }
  if (expr.or && Array.isArray(expr.or)) {
    for (const it of expr.or) walkFilters(it, visitCond);
    return;
  }
  if (typeof expr.field === "string" && typeof expr.op === "string") visitCond(expr);
}

export function validateEntityQuery(params: {
  schema: SchemaDef;
  entityName: string;
  decision: PolicyDecision;
  query: EntityQueryRequest;
}) {
  const q = params.query;

  if (q.select) {
    for (const f of q.select) {
      if (!isReadableField(f, params.decision)) throw new Error(`不可读字段：${f}`);
      if (!getFieldType(params.schema, params.entityName, f)) throw new Error(`字段不存在：${f}`);
    }
  }

  if (q.orderBy) {
    for (const o of q.orderBy) {
      if (!isReadableField(o.field, params.decision)) throw new Error(`不可读字段：${o.field}`);
      if (o.field === "updatedAt" || o.field === "createdAt" || o.field === "id") continue;
      const t = getFieldType(params.schema, params.entityName, o.field);
      if (!t) throw new Error(`字段不存在：${o.field}`);
      if (t === "json") throw new Error(`json 字段不支持排序：${o.field}`);
    }
  }

  walkFilters(q.filters, (c) => {
    if (!isReadableField(c.field, params.decision)) throw new Error(`不可读字段：${c.field}`);
    const t = getFieldType(params.schema, params.entityName, c.field);
    assertTypeCompatible(c.op, t, c.value);
  });
}
