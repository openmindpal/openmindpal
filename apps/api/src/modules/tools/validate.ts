import { Errors } from "../../lib/errors";

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

export function validateToolInput(inputSchema: any, input: unknown) {
  const fields = inputSchema?.fields;
  if (!fields) return;
  if (!isPlainObject(input)) throw Errors.inputSchemaInvalid("input 必须是对象");

  const schemaEntries = Object.entries<any>(fields).sort(([a], [b]) => a.localeCompare(b));
  for (const [fieldName, def] of schemaEntries) {
    const v = (input as any)[fieldName];
    const expectedType = String(def?.type ?? "");
    if (def?.required && (v === undefined || v === null)) {
      throw Errors.inputSchemaInvalid(`缺少必填字段：input.${fieldName}${expectedType ? `（期望 ${expectedType}）` : ""}`);
    }
    if (v !== undefined && v !== null && expectedType && !checkType(expectedType, v)) {
      const actualType = Array.isArray(v) ? "array" : typeof v;
      throw Errors.inputSchemaInvalid(`字段类型错误：input.${fieldName}（期望 ${expectedType}，实际 ${actualType}）`);
    }
  }

  const allowed = new Set(schemaEntries.map(([k]) => k));
  const extraKeys = Object.keys(input).filter((k) => !allowed.has(k)).sort((a, b) => a.localeCompare(b));
  if (extraKeys.length) {
    throw Errors.inputSchemaInvalid(`存在未声明字段：${extraKeys.map((k) => `input.${k}`).join(", ")}`);
  }
}
