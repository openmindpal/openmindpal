import type { SchemaDef } from "./schemaModel";
import { sha256Hex, stableStringify } from "../../lib/digest";

type CompatResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export type CompatLevelV1 = "compatible" | "migration_required" | "breaking";

export type SchemaDiffSummaryV1 = {
  entities: { added: number; removed: number; addedNames: string[]; removedNames: string[] };
  fields: { added: number; removed: number; addedPaths: string[]; removedPaths: string[] };
  required: { added: number; upgraded: number; addedPaths: string[]; upgradedPaths: string[] };
  type: { changed: number; changedPaths: string[] };
};

export type CompatReasonV1 = { code: string; message: string; path?: string };

export type CompatReportV1 = {
  level: CompatLevelV1;
  diffSummary: SchemaDiffSummaryV1;
  reasons: CompatReasonV1[];
  digest: { sha256_8: string };
};

function getNextVersion(prev: SchemaDef, next: SchemaDef) {
  const nextVersion = Number((next as any)?.version);
  if (Number.isFinite(nextVersion) && nextVersion > 0) return nextVersion;
  const prevVersion = Number((prev as any)?.version);
  if (Number.isFinite(prevVersion) && prevVersion > 0) return prevVersion + 1;
  return null;
}

function getDeprecatedWindow(field: any) {
  const meta = field?.deprecated;
  if (!meta) return null;
  if (meta === true) return { removeAfterVersion: null as number | null };
  if (typeof meta !== "object") return null;
  const removeAfter = Number((meta as any).removeAfterVersion);
  return { removeAfterVersion: Number.isFinite(removeAfter) ? removeAfter : null };
}

function stableDigest8(input: any) {
  return sha256Hex(stableStringify(input)).slice(0, 8);
}

export function computeSchemaCompatReportV1(prev: SchemaDef | null, next: SchemaDef): CompatReportV1 {
  if (!prev) {
    const nextEntities = (next?.entities ?? {}) as Record<string, any>;
    const nextEntityNames = Object.keys(nextEntities);
    const entitiesAdded = nextEntityNames.length;
    const entitiesRemoved = 0;
    const fieldsAddedPaths: string[] = [];
    let fieldsAdded = 0;
    let requiredAdded = 0;
    for (const [entityName, nextEntity] of Object.entries(nextEntities)) {
      const nextFields = (nextEntity?.fields ?? {}) as Record<string, any>;
      for (const [fieldName, field] of Object.entries(nextFields)) {
        fieldsAdded += 1;
        const path = `${entityName}.${fieldName}`;
        if (fieldsAddedPaths.length < 50) fieldsAddedPaths.push(path);
        if (Boolean((field as any)?.required)) requiredAdded += 1;
      }
    }
    const diffSummary: SchemaDiffSummaryV1 = {
      entities: { added: entitiesAdded, removed: entitiesRemoved, addedNames: nextEntityNames.slice(0, 50), removedNames: [] },
      fields: { added: fieldsAdded, removed: 0, addedPaths: fieldsAddedPaths, removedPaths: [] },
      required: { added: requiredAdded, upgraded: 0, addedPaths: [], upgradedPaths: [] },
      type: { changed: 0, changedPaths: [] },
    };
    const level: CompatLevelV1 = "compatible";
    const digest8 = stableDigest8({ v: 1, level, diffSummary, reasons: [] });
    return { level, diffSummary, reasons: [], digest: { sha256_8: digest8 } };
  }

  const prevEntities = (prev?.entities ?? {}) as Record<string, any>;
  const nextEntities = (next?.entities ?? {}) as Record<string, any>;
  const prevEntityNames = Object.keys(prevEntities);
  const nextEntityNames = Object.keys(nextEntities);
  const prevEntitySet = new Set(prevEntityNames);
  const nextEntitySet = new Set(nextEntityNames);

  let entitiesAdded = 0;
  let entitiesRemoved = 0;
  const entitiesAddedNames: string[] = [];
  const entitiesRemovedNames: string[] = [];
  for (const n of nextEntityNames) {
    if (prevEntitySet.has(n)) continue;
    entitiesAdded += 1;
    if (entitiesAddedNames.length < 50) entitiesAddedNames.push(n);
  }
  for (const n of prevEntityNames) {
    if (nextEntitySet.has(n)) continue;
    entitiesRemoved += 1;
    if (entitiesRemovedNames.length < 50) entitiesRemovedNames.push(n);
  }

  let fieldsAdded = 0;
  let fieldsRemoved = 0;
  const fieldsAddedPaths: string[] = [];
  const fieldsRemovedPaths: string[] = [];

  let requiredAdded = 0;
  let requiredUpgraded = 0;
  const requiredAddedPaths: string[] = [];
  const requiredUpgradedPaths: string[] = [];

  let typeChanged = 0;
  const typeChangedPaths: string[] = [];

  const reasons: CompatReasonV1[] = [];
  const nextVersion = prev ? getNextVersion(prev, next) : null;

  for (const entityName of prevEntityNames) {
    if (nextEntitySet.has(entityName)) continue;
    reasons.push({ code: "ENTITY_REMOVED", message: `实体被删除：${entityName}`, path: entityName });
  }

  for (const [entityName, nextEntity] of Object.entries(nextEntities)) {
    const prevEntity = prevEntities[entityName];
    const prevFields = (prevEntity?.fields ?? {}) as Record<string, any>;
    const nextFields = (nextEntity?.fields ?? {}) as Record<string, any>;
    const prevFieldNames = Object.keys(prevFields);
    const nextFieldNames = Object.keys(nextFields);
    const prevFieldSet = new Set(prevFieldNames);
    const nextFieldSet = new Set(nextFieldNames);

    for (const fieldName of nextFieldNames) {
      if (prevFieldSet.has(fieldName)) continue;
      fieldsAdded += 1;
      const path = `${entityName}.${fieldName}`;
      if (fieldsAddedPaths.length < 50) fieldsAddedPaths.push(path);
      if (Boolean(nextFields[fieldName]?.required)) {
        requiredAdded += 1;
        if (requiredAddedPaths.length < 50) requiredAddedPaths.push(path);
        reasons.push({ code: "FIELD_REQUIRED_ADDED", message: `新增必填字段：${path}`, path });
      }
    }

    for (const fieldName of prevFieldNames) {
      if (nextFieldSet.has(fieldName)) continue;
      fieldsRemoved += 1;
      const path = `${entityName}.${fieldName}`;
      if (fieldsRemovedPaths.length < 50) fieldsRemovedPaths.push(path);
      const prevField = prevFields[fieldName];
      const window = getDeprecatedWindow(prevField);
      if (!window) {
        reasons.push({ code: "FIELD_REMOVED_WITHOUT_DEPRECATION", message: `字段移除前必须先标记 deprecated：${path}`, path });
      } else if (!window.removeAfterVersion || !nextVersion || nextVersion < window.removeAfterVersion) {
        reasons.push({ code: "FIELD_REMOVAL_WINDOW_NOT_REACHED", message: `字段移除窗口未满足：${path}`, path });
      }
    }

    for (const fieldName of nextFieldNames) {
      if (!prevFieldSet.has(fieldName)) continue;
      const prevField = prevFields[fieldName];
      const nextField = nextFields[fieldName];
      const path = `${entityName}.${fieldName}`;

      if (String(nextField?.type ?? "") !== String(prevField?.type ?? "")) {
        typeChanged += 1;
        if (typeChangedPaths.length < 50) typeChangedPaths.push(path);
        reasons.push({
          code: "FIELD_TYPE_CHANGED",
          message: `字段类型变更：${path} (${prevField?.type ?? ""} -> ${nextField?.type ?? ""})`,
          path,
        });
      }

      const prevRequired = Boolean(prevField?.required);
      const nextRequired = Boolean(nextField?.required);
      if (!prevRequired && nextRequired) {
        requiredUpgraded += 1;
        if (requiredUpgradedPaths.length < 50) requiredUpgradedPaths.push(path);
        reasons.push({ code: "FIELD_REQUIRED_UPGRADED", message: `字段由可选变为必填：${path}`, path });
      }
    }
  }

  const diffSummary: SchemaDiffSummaryV1 = {
    entities: { added: entitiesAdded, removed: entitiesRemoved, addedNames: entitiesAddedNames, removedNames: entitiesRemovedNames },
    fields: { added: fieldsAdded, removed: fieldsRemoved, addedPaths: fieldsAddedPaths, removedPaths: fieldsRemovedPaths },
    required: { added: requiredAdded, upgraded: requiredUpgraded, addedPaths: requiredAddedPaths, upgradedPaths: requiredUpgradedPaths },
    type: { changed: typeChanged, changedPaths: typeChangedPaths },
  };

  const hasBreaking = reasons.some((r) => r.code === "ENTITY_REMOVED" || r.code === "FIELD_REMOVED_WITHOUT_DEPRECATION" || r.code === "FIELD_REMOVAL_WINDOW_NOT_REACHED" || r.code === "FIELD_TYPE_CHANGED");
  const hasMigration = !hasBreaking && (requiredAdded > 0 || requiredUpgraded > 0);
  const level: CompatLevelV1 = hasBreaking ? "breaking" : hasMigration ? "migration_required" : "compatible";

  reasons.sort((a, b) => `${a.code}:${a.path ?? ""}`.localeCompare(`${b.code}:${b.path ?? ""}`));

  const digest8 = stableDigest8({
    v: 1,
    level,
    diffSummary,
    reasons: reasons.map((r) => ({ code: r.code, path: r.path ?? null })),
  });

  return { level, diffSummary, reasons, digest: { sha256_8: digest8 } };
}

export function checkSchemaCompatibility(prev: SchemaDef | null, next: SchemaDef): CompatResult {
  if (!prev) return { ok: true };

  const prevEntities = prev.entities ?? {};
  const nextEntities = next.entities ?? {};
  const nextVersion = getNextVersion(prev, next);

  for (const [entityName, prevEntity] of Object.entries(prevEntities)) {
    const nextEntity = nextEntities[entityName];
    if (!nextEntity) return { ok: false, code: "ENTITY_REMOVED", reason: `实体被删除：${entityName}` };

    for (const [fieldName, prevField] of Object.entries(prevEntity.fields ?? {})) {
      const nextField = nextEntity.fields?.[fieldName];
      if (!nextField) {
        const window = getDeprecatedWindow(prevField);
        if (!window) {
          return { ok: false, code: "FIELD_REMOVED_WITHOUT_DEPRECATION", reason: `字段移除前必须先标记 deprecated：${entityName}.${fieldName}` };
        }
        if (!window.removeAfterVersion || !nextVersion || nextVersion < window.removeAfterVersion) {
          return {
            ok: false,
            code: "FIELD_REMOVAL_WINDOW_NOT_REACHED",
            reason: `字段移除窗口未满足：${entityName}.${fieldName}`,
          };
        }
        continue;
      }
      if (nextField.type !== prevField.type) {
        return {
          ok: false,
          code: "FIELD_TYPE_CHANGED",
          reason: `字段类型变更：${entityName}.${fieldName} (${prevField.type} -> ${nextField.type})`,
        };
      }
      const prevRequired = Boolean(prevField.required);
      const nextRequired = Boolean(nextField.required);
      if (prevRequired !== nextRequired && nextRequired) {
        return { ok: false, code: "FIELD_REQUIRED_UPGRADED", reason: `字段由可选变为必填：${entityName}.${fieldName}` };
      }
    }
  }

  for (const [entityName, nextEntity] of Object.entries(nextEntities)) {
    const prevEntity = prevEntities[entityName];
    if (!prevEntity) continue;
    for (const [fieldName, nextField] of Object.entries(nextEntity.fields ?? {})) {
      const prevField = prevEntity.fields?.[fieldName];
      if (!prevField && nextField.required) {
        return { ok: false, code: "FIELD_REQUIRED_ADDED", reason: `新增必填字段：${entityName}.${fieldName}` };
      }
    }
  }

  return { ok: true };
}
