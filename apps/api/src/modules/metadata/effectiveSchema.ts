import type { PolicyDecision, ConditionalFieldRule } from "@openslin/shared";
import type { SchemaDef } from "./schemaModel";

function allowAll(allow: string[] | undefined) {
  return Boolean(allow?.includes("*"));
}

export function buildEffectiveEntitySchema(params: {
  schema: SchemaDef;
  entityName: string;
  decision: PolicyDecision;
}) {
  const entity = params.schema.entities?.[params.entityName];
  if (!entity) return null;

  const readAllow = params.decision.fieldRules?.read?.allow;
  const readDeny = params.decision.fieldRules?.read?.deny ?? [];
  const writeAllow = params.decision.fieldRules?.write?.allow;
  const writeDeny = params.decision.fieldRules?.write?.deny ?? [];

  const conditionalRules: ConditionalFieldRule[] = params.decision.conditionalFieldRules ?? [];

  const fields: Record<string, any> = {};
  for (const [name, def] of Object.entries(entity.fields ?? {})) {
    // Static field rules
    if (readDeny.includes(name)) continue;
    if (readAllow && readAllow.length > 0 && !allowAll(readAllow) && !readAllow.includes(name)) continue;

    const writable =
      !writeDeny.includes(name) &&
      (!writeAllow || writeAllow.length === 0 || allowAll(writeAllow) || writeAllow.includes(name));

    // Conditional visibility / writability annotations
    const conditionalAnnotations: { condition: unknown; readable: boolean; writable: boolean }[] = [];
    for (const cr of conditionalRules) {
      const crReadDeny = cr.fieldRules?.read?.deny ?? [];
      const crReadAllow = cr.fieldRules?.read?.allow;
      const crWriteDeny = cr.fieldRules?.write?.deny ?? [];
      const crWriteAllow = cr.fieldRules?.write?.allow;

      const condReadable = !crReadDeny.includes(name) &&
        (!crReadAllow || crReadAllow.length === 0 || allowAll(crReadAllow) || crReadAllow.includes(name));
      const condWritable = !crWriteDeny.includes(name) &&
        (!crWriteAllow || crWriteAllow.length === 0 || allowAll(crWriteAllow) || crWriteAllow.includes(name));

      if (!condReadable || condWritable !== writable) {
        conditionalAnnotations.push({
          condition: cr.condition,
          readable: condReadable,
          writable: condWritable,
        });
      }
    }

    fields[name] = {
      ...def,
      writable,
      ...(conditionalAnnotations.length > 0 ? { conditionalAccess: conditionalAnnotations } : {}),
    };
  }

  return {
    schemaName: params.schema.name,
    schemaVersion: params.schema.version,
    entityName: params.entityName,
    displayName: entity.displayName,
    description: entity.description,
    fields,
  };
}

