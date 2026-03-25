import type { SchemaDef } from "./schemaModel";

function fillZhCN(obj: Record<string, string> | undefined) {
  if (!obj) return;
  if (obj["zh-CN"]) return;
  const first = Object.values(obj)[0];
  if (first) obj["zh-CN"] = first;
}

export function ensureSchemaI18nFallback(schema: SchemaDef): SchemaDef {
  fillZhCN(schema.displayName);
  fillZhCN(schema.description);

  for (const entity of Object.values(schema.entities ?? {})) {
    fillZhCN(entity.displayName);
    fillZhCN(entity.description);
    for (const field of Object.values(entity.fields ?? {})) {
      fillZhCN(field.displayName);
      fillZhCN(field.description);
    }
  }

  return schema;
}

