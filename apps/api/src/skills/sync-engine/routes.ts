import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getRecord, updateRecord } from "../../modules/data/dataRepo";
import { applyWriteFieldRules } from "../../modules/data/fieldRules";
import { validateEntityPayload } from "../../modules/data/validate";
import { authorize } from "../../modules/auth/authz";
import { getEffectiveSchema } from "../../modules/metadata/schemaRepo";
import { getOpByOpId, getServerWatermark, insertSyncOp, listOpsAfterCursor, upsertWatermark } from "./modules/syncRepo";
import { getMergeRunById, insertMergeRun } from "./modules/syncMergeRepo";
import { abandonConflictTicket, createConflictTicket, getConflictTicketById, listConflictTickets, resolveConflictTicket } from "./modules/syncConflictTicketRepo";

function stableStringify(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function toConflictClass(reason: string) {
  if (reason === "base_version_mismatch") return "base_version_stale";
  if (reason === "schema_not_released" || reason === "unknown_entity" || reason === "unknown_field" || reason === "field_type_invalid") return "schema_mismatch";
  if (reason === "permission_denied" || reason === "row_filter_denied" || reason === "field_write_forbidden") return "authz_denied";
  if (reason === "payload_invalid" || reason === "patch_must_be_object") return "validation_failed";
  if (reason === "record_missing" || reason === "record_already_exists") return "validation_failed";
  return "unknown";
}

function isRepairableConflict(c: any) {
  const cls = String(c?.conflictClass ?? "");
  return cls !== "authz_denied" && cls !== "validation_failed";
}

function patchValueKind(v: unknown) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "other";
}

function summarizePatch(patch: any) {
  const keys = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.keys(patch).sort() : [];
  const kinds: Record<string, string> = {};
  for (const k of keys) kinds[k] = patchValueKind(patch[k]);
  const kindSet = new Set(Object.values(kinds));
  const conflictType = kindSet.has("array") ? "list_conflict" : kindSet.has("object") ? "json_conflict" : "field_conflict";
  return { conflictType, touchedFields: keys, fieldKinds: kinds };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function computePatchDigest12(patch: any) {
  if (!isPlainObject(patch)) return null;
  return sha256Hex(stableStringify(patch)).slice(0, 12);
}

function buildAutoApplyProposal(params: { patch: any; serverPayload: any }) {
  if (!isPlainObject(params.patch)) return null;
  const server = isPlainObject(params.serverPayload) ? params.serverPayload : {};
  const keys = Object.keys(params.patch).sort();
  if (!keys.length) return null;
  for (const k of keys) {
    const v = (server as any)[k];
    if (v !== null && v !== undefined) return null;
  }
  const digest12 = sha256Hex(stableStringify(params.patch)).slice(0, 12);
  return { kind: "auto_apply_patch_if_unset", decision: "provide_merged_patch", mergedPatchDigest12: digest12, touchedFields: keys };
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

function validatePatch(params: { schema: any; entityName: string; patch: any }) {
  const entity = params.schema?.entities?.[params.entityName];
  if (!entity) return { ok: false as const, reason: "unknown_entity" };
  if (!isPlainObject(params.patch)) return { ok: false as const, reason: "patch_must_be_object" };
  const fields = entity.fields ?? {};
  for (const [k, v] of Object.entries(params.patch)) {
    const def = fields[k];
    if (!def) return { ok: false as const, reason: "unknown_field", field: k };
    if (!checkType(String(def.type ?? ""), v)) return { ok: false as const, reason: "field_type_invalid", field: k };
  }
  return { ok: true as const };
}

function matchesRowFilters(params: { rowFilters: any; subjectId: string; payload: any }): boolean {
  const rf = params.rowFilters;
  if (!rf) return true;
  if (typeof rf !== "object" || Array.isArray(rf)) return false;
  const kind = String((rf as any).kind ?? "");
  if (kind === "owner_only") return true;
  if (kind === "payload_field_eq_subject") {
    const field = String((rf as any).field ?? "");
    if (!field) return false;
    return String(params.payload?.[field] ?? "") === params.subjectId;
  }
  if (kind === "payload_field_eq_literal") {
    const field = String((rf as any).field ?? "");
    const value = (rf as any).value;
    if (!field) return false;
    return String(params.payload?.[field] ?? "") === String(value);
  }
  if (kind === "or" && Array.isArray((rf as any).rules)) {
    return (rf as any).rules.some((x: any) => matchesRowFilters({ rowFilters: x, subjectId: params.subjectId, payload: params.payload }));
  }
  if (kind === "and" && Array.isArray((rf as any).rules)) {
    return (rf as any).rules.every((x: any) => matchesRowFilters({ rowFilters: x, subjectId: params.subjectId, payload: params.payload }));
  }
  if (kind === "not" && (rf as any).rule) {
    return !matchesRowFilters({ rowFilters: (rf as any).rule, subjectId: params.subjectId, payload: params.payload });
  }
  if (kind === "space_member") {
    // In sync context, space_member is evaluated at SQL level;
    // at application level, degrade to pass (already filtered by DB query).
    return true;
  }
  if (kind === "org_hierarchy") {
    // In sync context, org_hierarchy is evaluated at SQL level;
    // at application level, degrade to pass (already filtered by DB query).
    return true;
  }
  if (kind === "expr") {
    // expr-based filters are evaluated at SQL level;
    // at application level degrade to pass.
    return true;
  }
  return false;
}

async function insertRecordWithId(params: {
  pool: any;
  tenantId: string;
  spaceId: string;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  id: string;
  payload: any;
  ownerSubjectId: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO entity_records (id, tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `,
    [params.id, params.tenantId, params.spaceId, params.entityName, params.schemaName, params.schemaVersion, params.payload, params.ownerSubjectId],
  );
  if (!res.rowCount) return null;
  return res.rows[0];
}

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.post("/sync/pull", async (req) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "sync", action: "pull" });
      const decision = await requirePermission({ req, resourceType: "sync", action: "pull" });
      req.ctx.audit!.policyDecision = decision;

      const subject = req.ctx.subject!;
      const body = z
        .object({
          cursor: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .parse(req.body);
      const cursor = body.cursor ?? 0;
      const limit = body.limit ?? 200;

      const ops = await listOpsAfterCursor({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, cursor, limit });
      const nextCursor = ops.length ? ops[ops.length - 1].cursor : cursor;
      const snapshotVersion = nextCursor;
      req.ctx.audit!.outputDigest = { cursor, nextCursor, opCount: ops.length };
      app.metrics.observeSyncPull({ result: "ok", latencyMs: Date.now() - startedAt, opsReturned: ops.length });
      return { ops, nextCursor, snapshotVersion };
    } catch (e: any) {
      app.metrics.observeSyncPull({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt, opsReturned: 0 });
      throw e;
    }
  });

  app.post("/sync/push", async (req) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "sync", action: "push" });
      const decision = await requirePermission({ req, resourceType: "sync", action: "push" });
      req.ctx.audit!.policyDecision = decision;

      const subject = req.ctx.subject!;
      const body = z
        .object({
          clientId: z.string().min(1),
          deviceId: z.string().min(1).optional(),
          ops: z
            .array(
              z.object({
                opId: z.string().min(1),
                schemaName: z.string().min(1),
                schemaVersion: z.number().int().positive().optional(),
                entityName: z.string().min(1),
                recordId: z.string().uuid(),
                baseVersion: z.number().int().nonnegative().nullable().optional(),
                patch: z.record(z.string(), z.any()),
                clock: z.any().optional(),
              }),
            )
            .max(500),
        })
        .parse(req.body);

    const digestInput = body.ops
      .map((o) => {
        const contentDigest = sha256Hex(stableStringify({ schemaName: o.schemaName, entityName: o.entityName, recordId: o.recordId, patch: o.patch }));
        return { opId: o.opId, contentDigest };
      })
      .sort((a, b) => a.opId.localeCompare(b.opId));
    const digest = sha256Hex(stableStringify(digestInput));

    const accepted: any[] = [];
    const rejected: any[] = [];
    const conflicts: any[] = [];
    let lastCursorInBatch = 0;
    let deduped = 0;
    const schemaCache = new Map<string, any>();

    for (const op of body.ops) {
      const contentDigest = sha256Hex(stableStringify({ schemaName: op.schemaName, entityName: op.entityName, recordId: op.recordId, patch: op.patch }));

      const existing = await getOpByOpId({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, opId: op.opId });
      if (existing) {
        accepted.push({ opId: op.opId, cursor: existing.cursor, deduped: true, status: existing.status });
        deduped += 1;
        lastCursorInBatch = Math.max(lastCursorInBatch, existing.cursor);
        continue;
      }

      let schema = schemaCache.get(op.schemaName) ?? null;
      if (!schema) {
        schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: op.schemaName });
        schemaCache.set(op.schemaName, schema);
      }
      if (!schema) {
        rejected.push({ opId: op.opId, reason: "schema_not_released" });
        const patchSummary = summarizePatch(op.patch);
        const conflictClass = toConflictClass("schema_not_released");
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "schema_not_released",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["check_schema_publish"],
            ...patchSummary,
          },
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const currentAny = await getRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: op.entityName,
        id: op.recordId,
      });

      const isCreate = !currentAny;
      const entityAction = isCreate ? "create" : "update";
      const entityDecision = await authorize({
        pool: app.db,
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "entity",
        action: entityAction,
      });
      if (entityDecision.decision !== "allow") {
        rejected.push({ opId: op.opId, reason: entityDecision.reason ?? "permission_denied" });
        const patchSummary = summarizePatch(op.patch);
        const reasonCode = String(entityDecision.reason ?? "permission_denied");
        const conflictClass = toConflictClass(reasonCode);
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode,
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["check_permissions"],
            ...patchSummary,
          },
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const patchCheck = validatePatch({ schema: schema.schema, entityName: op.entityName, patch: op.patch });
      if (!patchCheck.ok) {
        rejected.push({ opId: op.opId, reason: patchCheck.reason, field: (patchCheck as any).field ?? undefined });
        const patchSummary = summarizePatch(op.patch);
        const reasonCode = String(patchCheck.reason);
        const conflictClass = toConflictClass(reasonCode);
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode,
            fieldPaths,
            field: (patchCheck as any).field ?? null,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["fix_payload_then_retry"],
            ...patchSummary,
          },
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      let patch: any = op.patch;
      try {
        patch = applyWriteFieldRules(op.patch, entityDecision);
      } catch (e: any) {
        const fields = Array.isArray(e?.fields) ? e.fields : [];
        rejected.push({ opId: op.opId, reason: "field_write_forbidden", fields });
        const patchSummary = summarizePatch(op.patch);
        const conflictClass = toConflictClass("field_write_forbidden");
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "field_write_forbidden",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            fields,
            resolutionHints: ["remove_forbidden_fields"],
            ...patchSummary,
          },
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      if (!currentAny) {
        const base = op.baseVersion ?? 0;
        if (base > 0) {
          const patchSummary = summarizePatch(op.patch);
          const conflictClass = toConflictClass("record_missing");
          const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
          const conflict = {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "record_missing",
            fieldPaths,
            baseVersion: base,
            resolutionHints: ["refresh_and_retry"],
            candidatesSummary: { serverRevision: null, baseVersion: base },
            ...patchSummary,
          };
          conflicts.push(conflict);
          rejected.push({ opId: op.opId, reason: "record_missing" });
          const ins = await insertSyncOp({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId!,
            opId: op.opId,
            clientId: body.clientId,
            deviceId: body.deviceId ?? null,
            schemaName: op.schemaName,
            entityName: op.entityName,
            recordId: op.recordId,
            baseRevision: op.baseVersion ?? null,
            patch: op.patch,
            contentDigest,
            status: "rejected",
            conflictJson: conflict,
          });
          lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
          continue;
        }

        const schemaVersion = op.schemaVersion ?? 1;
        const payload = patch;
        const validation = validateEntityPayload({ schema: schema.schema, entityName: op.entityName, payload });
        if (!validation.ok) {
          rejected.push({ opId: op.opId, reason: "payload_invalid" });
          const patchSummary = summarizePatch(op.patch);
          const conflictClass = toConflictClass("payload_invalid");
          const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
          const conflict = {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "payload_invalid",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["fix_payload_then_retry"],
            ...patchSummary,
          };
          const ins = await insertSyncOp({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId!,
            opId: op.opId,
            clientId: body.clientId,
            deviceId: body.deviceId ?? null,
            schemaName: op.schemaName,
            entityName: op.entityName,
            recordId: op.recordId,
            baseRevision: op.baseVersion ?? null,
            patch: op.patch,
            contentDigest,
            status: "rejected",
            conflictJson: conflict,
          });
          lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
          continue;
        }

        if (!matchesRowFilters({ rowFilters: entityDecision.rowFilters, subjectId: subject.subjectId, payload })) {
          rejected.push({ opId: op.opId, reason: "row_filter_denied" });
          const patchSummary = summarizePatch(op.patch);
          const conflictClass = toConflictClass("row_filter_denied");
          const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
          const conflict = {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "row_filter_denied",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["check_row_filters"],
            ...patchSummary,
          };
          const ins = await insertSyncOp({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId!,
            opId: op.opId,
            clientId: body.clientId,
            deviceId: body.deviceId ?? null,
            schemaName: op.schemaName,
            entityName: op.entityName,
            recordId: op.recordId,
            baseRevision: op.baseVersion ?? null,
            patch: op.patch,
            contentDigest,
            status: "rejected",
            conflictJson: conflict,
          });
          lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
          continue;
        }

        const insertedRecord = await insertRecordWithId({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          entityName: op.entityName,
          schemaName: op.schemaName,
          schemaVersion,
          id: op.recordId,
          payload,
          ownerSubjectId: subject.subjectId,
        });
        if (!insertedRecord) {
          const patchSummary = summarizePatch(op.patch);
          const conflictClass = toConflictClass("record_already_exists");
          const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
          const conflict = {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "record_already_exists",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["refresh_and_retry"],
            candidatesSummary: { serverRevision: "unknown", baseVersion: op.baseVersion ?? null },
            ...patchSummary,
          };
          conflicts.push(conflict);
          rejected.push({ opId: op.opId, reason: "record_already_exists" });
          const ins = await insertSyncOp({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId!,
            opId: op.opId,
            clientId: body.clientId,
            deviceId: body.deviceId ?? null,
            schemaName: op.schemaName,
            entityName: op.entityName,
            recordId: op.recordId,
            baseRevision: op.baseVersion ?? null,
            patch: op.patch,
            contentDigest,
            status: "rejected",
            conflictJson: conflict,
          });
          lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
          continue;
        }

        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "accepted",
        });
        accepted.push({ opId: op.opId, cursor: ins.row.cursor });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const visibleCurrent = await getRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: op.entityName,
        id: op.recordId,
        subjectId: subject.subjectId,
        rowFilters: entityDecision.rowFilters ?? null,
        policyContext: {
          subject: { id: subject.subjectId },
          tenant: { id: subject.tenantId },
          space: { id: subject.spaceId ?? null },
          request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
          resource: { type: `entity:${op.entityName}`, id: op.recordId },
          policyCacheEpoch: (entityDecision as any).policyCacheEpoch ?? null,
        },
      });
      if (!visibleCurrent) {
        rejected.push({ opId: op.opId, reason: "row_filter_denied" });
        const patchSummary = summarizePatch(op.patch);
        const conflictClass = toConflictClass("row_filter_denied");
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: {
            opId: op.opId,
            targetRef: `${op.entityName}:${op.recordId}`,
            conflictClass,
            reasonCode: "row_filter_denied",
            fieldPaths,
            baseVersion: op.baseVersion ?? null,
            resolutionHints: ["check_row_filters"],
            ...patchSummary,
          },
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const expected = op.baseVersion ?? null;
      if (expected !== null && expected !== visibleCurrent.revision) {
        const patchSummary = summarizePatch(op.patch);
        const serverDigest = sha256Hex(stableStringify(visibleCurrent.payload ?? {})).slice(0, 12);
        const conflictClass = toConflictClass("base_version_mismatch");
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const proposal = buildAutoApplyProposal({ patch, serverPayload: visibleCurrent.payload });
        const conflict = {
          opId: op.opId,
          targetRef: `${op.entityName}:${op.recordId}`,
          conflictClass,
          reasonCode: "base_version_mismatch",
          fieldPaths,
          baseVersion: expected,
          serverVersion: visibleCurrent.revision,
          candidatesSummary: { serverRevision: visibleCurrent.revision, baseVersion: expected, serverPayloadDigest12: serverDigest },
          proposal,
          resolutionHints: ["pull_latest_then_rebase"],
          ...patchSummary,
        };
        conflicts.push(conflict);
        rejected.push({ opId: op.opId, reason: "base_version_mismatch" });
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: conflict,
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const updated = await updateRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: op.entityName,
        id: op.recordId,
        patch,
        expectedRevision: expected ?? undefined,
        subjectId: subject.subjectId,
        rowFilters: entityDecision.rowFilters ?? null,
        policyContext: {
          subject: { id: subject.subjectId },
          tenant: { id: subject.tenantId },
          space: { id: subject.spaceId ?? null },
          request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
          resource: { type: `entity:${op.entityName}`, id: op.recordId },
          policyCacheEpoch: (entityDecision as any).policyCacheEpoch ?? null,
        },
      });
      if (!updated) {
        const patchSummary = summarizePatch(op.patch);
        const serverDigest = sha256Hex(stableStringify(visibleCurrent.payload ?? {})).slice(0, 12);
        const conflictClass = toConflictClass("base_version_mismatch");
        const fieldPaths = Array.isArray(patchSummary?.touchedFields) ? patchSummary.touchedFields : null;
        const proposal = buildAutoApplyProposal({ patch, serverPayload: visibleCurrent.payload });
        const conflict = {
          opId: op.opId,
          targetRef: `${op.entityName}:${op.recordId}`,
          conflictClass,
          reasonCode: "base_version_mismatch",
          fieldPaths,
          baseVersion: expected,
          serverVersion: visibleCurrent.revision,
          candidatesSummary: { serverRevision: visibleCurrent.revision, baseVersion: expected, serverPayloadDigest12: serverDigest },
          proposal,
          resolutionHints: ["pull_latest_then_rebase"],
          ...patchSummary,
        };
        conflicts.push(conflict);
        rejected.push({ opId: op.opId, reason: "base_version_mismatch" });
        const ins = await insertSyncOp({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId!,
          opId: op.opId,
          clientId: body.clientId,
          deviceId: body.deviceId ?? null,
          schemaName: op.schemaName,
          entityName: op.entityName,
          recordId: op.recordId,
          baseRevision: op.baseVersion ?? null,
          patch: op.patch,
          contentDigest,
          status: "rejected",
          conflictJson: conflict,
        });
        lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
        continue;
      }

      const ins = await insertSyncOp({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId!,
        opId: op.opId,
        clientId: body.clientId,
        deviceId: body.deviceId ?? null,
        schemaName: op.schemaName,
        entityName: op.entityName,
        recordId: op.recordId,
        baseRevision: op.baseVersion ?? null,
        patch: op.patch,
        contentDigest,
        status: "accepted",
      });
      accepted.push({ opId: op.opId, cursor: ins.row.cursor });
      lastCursorInBatch = Math.max(lastCursorInBatch, ins.row.cursor);
    }

    const serverWatermark = await getServerWatermark({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId! });
    await upsertWatermark({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      clientId: body.clientId,
      deviceId: body.deviceId ?? null,
      lastPushedCursor: lastCursorInBatch,
    });

    const acceptedSorted = [...accepted].sort((a, b) => String(a.opId).localeCompare(String(b.opId)));
    const rejectedSorted = [...rejected].sort((a, b) => String(a.opId).localeCompare(String(b.opId)));
    const conflictsSorted = [...conflicts].sort((a, b) => String(a.opId).localeCompare(String(b.opId)));

    const mergeTranscript = {
      mergeId: "",
      accepted: acceptedSorted,
      rejected: rejectedSorted,
      conflicts: conflictsSorted,
      sideEffectsSummary: { serverWatermark, lastCursorInBatch, deduped },
    };
    const mergeDigest = sha256Hex(stableStringify(mergeTranscript));
    const mergeId = sha256Hex(stableStringify({ tenantId: subject.tenantId, spaceId: subject.spaceId!, inputDigest: digest, mergeDigest }));
    mergeTranscript.mergeId = mergeId;
    const mergeDigest2 = sha256Hex(stableStringify(mergeTranscript));

    const mergeRun = await insertMergeRun({
      pool: app.db,
      mergeId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      actorSubjectId: subject.subjectId,
      inputDigest: digest,
      mergeDigest: mergeDigest2,
      acceptedCount: acceptedSorted.length,
      rejectedCount: rejectedSorted.length,
      conflictsCount: conflictsSorted.length,
      transcriptJson: mergeTranscript,
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId ?? null,
    });

    let repairTicketId: string | null = null;
    const hasRepairable = conflictsSorted.some(isRepairableConflict);
    if (conflictsSorted.length > 0 && hasRepairable) {
      const t = await createConflictTicket({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, mergeId: mergeRun.row.mergeId, conflictsJson: conflictsSorted, traceId: req.ctx.traceId, requestId: req.ctx.requestId ?? null });
      repairTicketId = t.ticketId;
    }

    req.ctx.audit!.outputDigest = {
      opCount: body.ops.length,
      accepted: accepted.length,
      rejected: rejected.length,
      conflicts: conflicts.length,
      digest,
      mergeId,
      mergeDigest: mergeRun.row.mergeDigest,
      repairTicketId,
      serverWatermark,
    };

    app.metrics.observeSyncPush({ result: "ok", latencyMs: Date.now() - startedAt, conflicts: conflicts.length, deduped });
    return {
      accepted,
      rejected,
      serverWatermark,
      conflicts,
      digest,
      mergeId,
      mergeDigest: mergeRun.row.mergeDigest,
      repairTicketId,
      mergeSummary: {
        mergeId,
        inputDigest: digest,
        mergeDigest: mergeRun.row.mergeDigest,
        acceptedCount: acceptedSorted.length,
        rejectedCount: rejectedSorted.length,
        conflictsCount: conflictsSorted.length,
      },
    };
    } catch (e: any) {
      app.metrics.observeSyncPush({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt, conflicts: 0, deduped: 0 });
      throw e;
    }
  });

  app.get("/sync/conflict-tickets", async (req) => {
    try {
      setAuditContext(req, { resourceType: "sync", action: "ticket.list" });
      const decision = await requirePermission({ req, resourceType: "sync", action: "ticket.list" });
      req.ctx.audit!.policyDecision = decision;

      const subject = req.ctx.subject!;
      const q = z
        .object({
          status: z.enum(["open", "resolved", "abandoned"]).optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
          cursorUpdatedAt: z.string().optional(),
          cursorTicketId: z.string().uuid().optional(),
        })
        .parse(req.query);

      const rows = await listConflictTickets({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId!,
        status: q.status,
        limit: q.limit ?? 50,
        cursor: q.cursorUpdatedAt && q.cursorTicketId ? { updatedAt: q.cursorUpdatedAt, ticketId: q.cursorTicketId } : null,
      });
      const nextCursor = rows.length ? { updatedAt: rows[rows.length - 1].updatedAt, ticketId: rows[rows.length - 1].ticketId } : null;
      req.ctx.audit!.outputDigest = { count: rows.length, nextCursor: nextCursor ? { hasMore: true } : null };
      return { tickets: rows, nextCursor };
    } catch (e: any) {
      throw e;
    }
  });

  app.get("/sync/conflict-tickets/:ticketId", async (req) => {
    setAuditContext(req, { resourceType: "sync", action: "ticket.read" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "ticket.read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ ticketId: z.string().uuid() }).parse(req.params);
    const row = await getConflictTicketById({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: params.ticketId });
    if (!row) throw Errors.notFound();
    req.ctx.audit!.outputDigest = { ticketId: row.ticketId, status: row.status, conflictCount: Array.isArray(row.conflictsJson) ? row.conflictsJson.length : 0 };
    return { ticket: row };
  });

  app.post("/sync/conflict-tickets/:ticketId/abandon", async (req) => {
    setAuditContext(req, { resourceType: "sync", action: "ticket.abandon" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "ticket.abandon" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ ticketId: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    const row = await abandonConflictTicket({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: params.ticketId, reason: body.reason ?? null });
    if (!row) throw Errors.notFound();
    req.ctx.audit!.outputDigest = { ticketId: row.ticketId, status: row.status };
    return { ticket: row };
  });

  app.post("/sync/conflict-tickets/:ticketId/resolve", async (req) => {
    setAuditContext(req, { resourceType: "sync", action: "ticket.resolve" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "ticket.resolve" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ ticketId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        resolution: z
          .object({
            decisions: z.array(z.object({ opId: z.string().min(1), decision: z.enum(["use_server", "use_client", "provide_merged_patch"]), mergedPatch: z.record(z.string(), z.any()).optional() })).max(500),
          })
          .optional(),
      })
      .parse(req.body ?? {});

    const ticket = await getConflictTicketById({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: params.ticketId });
    if (!ticket) throw Errors.notFound();
    if (ticket.status !== "open") throw Errors.badRequest("ticket_not_open");

    const transcript = {
      mergeId: "",
      accepted: [],
      rejected: [],
      conflicts: Array.isArray(ticket.conflictsJson) ? ticket.conflictsJson : [],
      sideEffectsSummary: { ticketId: ticket.ticketId, resolvedWithoutApply: true, resolution: body.resolution ?? null },
    };
    const inputDigest = sha256Hex(stableStringify({ sourceMergeId: ticket.mergeId, ticketId: ticket.ticketId, resolution: body.resolution ?? null }));
    const digest0 = sha256Hex(stableStringify(transcript));
    const resolvedMergeId = sha256Hex(stableStringify({ tenantId: subject.tenantId, spaceId: subject.spaceId!, inputDigest, mergeDigest: digest0 }));
    transcript.mergeId = resolvedMergeId;
    const mergeDigest = sha256Hex(stableStringify(transcript));

    await insertMergeRun({
      pool: app.db,
      mergeId: resolvedMergeId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      actorSubjectId: subject.subjectId,
      inputDigest,
      mergeDigest,
      acceptedCount: 0,
      rejectedCount: 0,
      conflictsCount: Array.isArray(ticket.conflictsJson) ? ticket.conflictsJson.length : 0,
      transcriptJson: transcript,
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId ?? null,
    });

    const updated = await resolveConflictTicket({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: ticket.ticketId, resolvedMergeId });
    if (!updated) throw Errors.notFound();
    req.ctx.audit!.outputDigest = { ticketId: updated.ticketId, status: updated.status, resolvedMergeId };
    return { ticket: updated, mergeId: resolvedMergeId, mergeDigest };
  });

  app.post("/sync/conflict-tickets/:ticketId/apply-proposal", async (req, reply) => {
    setAuditContext(req, { resourceType: "sync", action: "ticket.apply_proposal" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "ticket.resolve" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ ticketId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        opIds: z.array(z.string().min(1).max(200)).max(500).optional(),
      })
      .parse(req.body ?? {});

    const ticket = await getConflictTicketById({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: params.ticketId });
    if (!ticket) throw Errors.notFound();
    if (ticket.status !== "open") throw Errors.badRequest("ticket_not_open");

    const wanted = Array.isArray(body.opIds) && body.opIds.length ? new Set(body.opIds) : null;
    const conflicts = Array.isArray(ticket.conflictsJson) ? ticket.conflictsJson : [];
    const candidates = conflicts.filter((c: any) => {
      if (!c || typeof c !== "object") return false;
      const opId = String((c as any).opId ?? "");
      if (!opId) return false;
      if (wanted && !wanted.has(opId)) return false;
      return String((c as any).reasonCode ?? "") === "base_version_mismatch" && String((c as any).conflictClass ?? "") === "base_version_stale";
    });
    if (!candidates.length) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "SYNC_NO_APPLICABLE_PROPOSAL", message: { "zh-CN": "没有可应用的合并提案", "en-US": "No applicable proposal" }, traceId: req.ctx.traceId });
    }

    const appliedOps: any[] = [];
    for (const c of candidates) {
      const opId = String((c as any).opId ?? "");
      const targetRef = String((c as any).targetRef ?? "");
      const proposal = (c as any).proposal ?? null;
      const mergedPatchDigest12 = typeof proposal?.mergedPatchDigest12 === "string" ? String(proposal.mergedPatchDigest12) : null;

      const op = await getOpByOpId({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, opId });
      if (!op) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "同步操作不存在", "en-US": "Sync op not found" }, traceId: req.ctx.traceId });
      }

      const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, name: String(op.schemaName ?? "core") });
      if (!schema) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SCHEMA_NOT_RELEASED", message: { "zh-CN": "Schema 未发布", "en-US": "Schema not released" }, traceId: req.ctx.traceId });
      }

      const currentAny = await getRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: String(op.entityName),
        id: String(op.recordId),
      });
      if (!currentAny) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "记录不存在，无法应用提案", "en-US": "Record missing" }, traceId: req.ctx.traceId });
      }

      const entityDecision = await authorize({
        pool: app.db,
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "entity",
        action: "update",
      });
      if (entityDecision.decision !== "allow") {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(403).send({ errorCode: "POLICY_VIOLATION", message: { "zh-CN": "权限不足，无法应用提案", "en-US": "Permission denied" }, traceId: req.ctx.traceId });
      }

      const patchCheck = validatePatch({ schema: schema.schema, entityName: String(op.entityName), patch: op.patch });
      if (!patchCheck.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "补丁非法，无法应用提案", "en-US": "Invalid patch" }, traceId: req.ctx.traceId });
      }

      let patch: any = op.patch;
      try {
        patch = applyWriteFieldRules(op.patch, entityDecision);
      } catch {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "字段规则拒绝，无法应用提案", "en-US": "Field rule denied" }, traceId: req.ctx.traceId });
      }

      if (!isPlainObject(patch)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "补丁非法，无法应用提案", "en-US": "Invalid patch" }, traceId: req.ctx.traceId });
      }
      if (mergedPatchDigest12 && sha256Hex(stableStringify(patch)).slice(0, 12) !== mergedPatchDigest12) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "提案摘要不一致，无法应用", "en-US": "Proposal digest mismatch" }, traceId: req.ctx.traceId });
      }

      const safeNow = buildAutoApplyProposal({ patch, serverPayload: currentAny.payload });
      if (!safeNow) continue;

      const beforeRevision = currentAny.revision;
      const updated = await updateRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: String(op.entityName),
        id: String(op.recordId),
        patch,
        subjectId: subject.subjectId,
        rowFilters: entityDecision.rowFilters ?? null,
        policyContext: {
          subject: { id: subject.subjectId },
          tenant: { id: subject.tenantId },
          space: { id: subject.spaceId ?? null },
          request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
          resource: { type: `entity:${String(op.entityName)}`, id: String(op.recordId) },
          policyCacheEpoch: (entityDecision as any).policyCacheEpoch ?? null,
        },
      });
      if (!updated) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "SYNC_CANNOT_APPLY", message: { "zh-CN": "更新失败，无法应用提案", "en-US": "Update failed" }, traceId: req.ctx.traceId });
      }
      appliedOps.push({ opId, targetRef, beforeRevision, afterRevision: updated.revision, patchDigest12: sha256Hex(stableStringify(patch)).slice(0, 12) });
    }

    if (!appliedOps.length) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "SYNC_NO_APPLICABLE_PROPOSAL", message: { "zh-CN": "没有可应用的合并提案", "en-US": "No applicable proposal" }, traceId: req.ctx.traceId });
    }

    const transcript = {
      mergeId: "",
      accepted: [],
      rejected: [],
      conflicts,
      sideEffectsSummary: { ticketId: ticket.ticketId, appliedOpsCount: appliedOps.length, appliedOps, resolvedWithoutApply: false },
    };
    const inputDigest = sha256Hex(stableStringify({ sourceMergeId: ticket.mergeId, ticketId: ticket.ticketId, action: "apply_proposal", appliedOpsCount: appliedOps.length }));
    const digest0 = sha256Hex(stableStringify(transcript));
    const resolvedMergeId = sha256Hex(stableStringify({ tenantId: subject.tenantId, spaceId: subject.spaceId!, inputDigest, mergeDigest: digest0 }));
    transcript.mergeId = resolvedMergeId;
    const mergeDigest = sha256Hex(stableStringify(transcript));

    await insertMergeRun({
      pool: app.db,
      mergeId: resolvedMergeId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      actorSubjectId: subject.subjectId,
      inputDigest,
      mergeDigest,
      acceptedCount: 0,
      rejectedCount: 0,
      conflictsCount: conflicts.length,
      transcriptJson: transcript,
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId ?? null,
    });
    const updatedTicket = await resolveConflictTicket({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, ticketId: ticket.ticketId, resolvedMergeId });
    if (!updatedTicket) throw Errors.notFound();
    req.ctx.audit!.outputDigest = { ticketId: updatedTicket.ticketId, status: updatedTicket.status, resolvedMergeId, appliedOps: appliedOps.length };
    return { ticket: updatedTicket, mergeId: resolvedMergeId, mergeDigest, appliedOps };
  });

  app.get("/sync/merge-runs/:mergeId", async (req) => {
    setAuditContext(req, { resourceType: "sync", action: "merge_run.read" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "merge_run.read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ mergeId: z.string().min(1).max(200) }).parse(req.params);
    const row = await getMergeRunById({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, mergeId: params.mergeId });
    if (!row) throw Errors.notFound();
    req.ctx.audit!.outputDigest = { mergeId: row.mergeId, inputDigest: row.inputDigest, mergeDigest: row.mergeDigest, conflicts: row.conflictsCount };
    return { mergeRun: row };
  });

  app.post("/sync/merge-runs/:mergeId/verify", async (req) => {
    setAuditContext(req, { resourceType: "sync", action: "merge_run.verify" });
    const decision = await requirePermission({ req, resourceType: "sync", action: "merge_run.verify" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const params = z.object({ mergeId: z.string().min(1).max(200) }).parse(req.params);
    const row = await getMergeRunById({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, mergeId: params.mergeId });
    if (!row) throw Errors.notFound();
    const recomputedDigest = sha256Hex(stableStringify(row.transcriptJson ?? {}));
    const ok = recomputedDigest === row.mergeDigest;
    req.ctx.audit!.outputDigest = { mergeId: row.mergeId, ok };
    return { ok, recomputedDigest, expectedDigest: row.mergeDigest };
  });
};
