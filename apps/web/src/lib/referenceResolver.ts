import type { FieldDef } from "./types";

/**
 * Lookup map: fieldName → { recordId → displayLabel }
 */
export type RefLabelMap = Record<string, Record<string, string>>;

/**
 * Server-side batch resolver for reference field display values.
 * Collects all unique reference IDs from items, fetches their display values
 * in parallel, and returns a nested lookup map.
 *
 * @param fields   - effective schema fields
 * @param items    - list of entity records (each has .payload or is the payload itself)
 * @param fetchOne - async function that loads a single record by entity+id (returns payload object or null)
 */
export async function resolveReferenceLabels(params: {
  fields: Record<string, FieldDef>;
  items: Array<Record<string, unknown>>;
  fetchOne: (entity: string, id: string) => Promise<Record<string, unknown> | null>;
}): Promise<RefLabelMap> {
  const { fields, items, fetchOne } = params;
  const result: RefLabelMap = {};

  // 1. Group unique IDs per field
  const groups: Record<
    string,
    { referenceEntity: string; displayField: string; ids: Set<string> }
  > = {};

  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.type !== "reference" || !def.referenceEntity) continue;
    const ids = new Set<string>();
    for (const item of items) {
      const payload =
        item.payload && typeof item.payload === "object"
          ? (item.payload as Record<string, unknown>)
          : item;
      const val = payload[fieldName];
      if (typeof val === "string" && val) ids.add(val);
    }
    if (ids.size > 0) {
      groups[fieldName] = {
        referenceEntity: def.referenceEntity,
        displayField: def.displayField ?? "name",
        ids,
      };
    }
  }

  // 2. Deduplicate across fields that share the same entity+id
  type FetchJob = {
    fieldName: string;
    id: string;
    displayField: string;
    entity: string;
  };
  const jobs: FetchJob[] = [];
  // Cache: entity+id → promise (avoid fetching same record twice)
  const cache = new Map<string, Promise<Record<string, unknown> | null>>();

  for (const [fieldName, group] of Object.entries(groups)) {
    for (const id of group.ids) {
      const cacheKey = `${group.referenceEntity}::${id}`;
      if (!cache.has(cacheKey)) {
        cache.set(cacheKey, fetchOne(group.referenceEntity, id));
      }
      jobs.push({
        fieldName,
        id,
        displayField: group.displayField,
        entity: group.referenceEntity,
      });
    }
  }

  // 3. Await all unique fetches
  await Promise.all(cache.values());

  // 4. Build lookup map
  for (const job of jobs) {
    const cacheKey = `${job.entity}::${job.id}`;
    let label = job.id; // Fallback to id
    try {
      const rec = await cache.get(cacheKey);
      if (rec) {
        const payload =
          rec.payload && typeof rec.payload === "object"
            ? (rec.payload as Record<string, unknown>)
            : rec;
        const resolved = payload[job.displayField] ?? payload.name;
        if (resolved != null) label = String(resolved);
      }
    } catch {
      // Keep fallback
    }
    if (!result[job.fieldName]) result[job.fieldName] = {};
    result[job.fieldName][job.id] = label;
  }

  return result;
}
