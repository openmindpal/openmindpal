import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { applyReadFieldRules, applyWriteFieldRules } from "../modules/data/fieldRules";
import { getIdempotencyRecord, insertIdempotencyRecord } from "../modules/data/idempotencyRepo";
import { deleteRecord, getRecord, insertRecord, listRecords, queryRecords, updateRecord } from "../modules/data/dataRepo";
import { entityQueryRequestSchema } from "../modules/data/queryModel";
import { validateEntityQuery } from "../modules/data/queryValidate";
import { validateEntityPayload, validateReferenceFields } from "../modules/data/validate";
import { getEffectiveSchema } from "../modules/metadata/schemaRepo";
import crypto from "node:crypto";
import { createJobRunStepWithoutToolRef } from "../modules/workflow/jobRepo";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import type { AuditEventInput } from "../modules/audit/auditRepo";

export const entityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/entities/:entity", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "entity", action: "read" });
    const decision = await requirePermission({ req, resourceType: "entity", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}` },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };

    const items = await listRecords({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      entityName: params.entity,
      limit,
      subjectId: subject.subjectId,
      rowFilters: decision.rowFilters ?? null,
      policyContext,
    });

    return {
      items: items.map((r) => ({
        ...r,
        payload: applyReadFieldRules(r.payload ?? {}, decision),
      })),
    };
  });

  app.get("/entities/:entity/:id", async (req, reply) => {
    const params = z.object({ entity: z.string(), id: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "entity", action: "read" });
    const decision = await requirePermission({ req, resourceType: "entity", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}`, id: params.id },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };
    const rec = await getRecord({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      entityName: params.entity,
      id: params.id,
      subjectId: subject.subjectId,
      rowFilters: decision.rowFilters ?? null,
      policyContext,
    });
    if (!rec) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "记录不存在", "en-US": "Not found" }, traceId: req.ctx.traceId });
    return { ...rec, payload: applyReadFieldRules(rec.payload ?? {}, decision) };
  });

  app.post("/entities/:entity/query", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "entity", action: "query" });
    const decision = await requirePermission({ req, resourceType: "entity", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = entityQueryRequestSchema.parse(req.body);
    const schemaName = body.schemaName ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);

    const entity = schema.schema.entities?.[params.entity];
    if (!entity) throw Errors.badRequest("实体不存在");
    const fieldTypes: Record<string, string> = {};
    for (const [k, def] of Object.entries<any>(entity.fields ?? {})) fieldTypes[k] = def.type;

    try {
      validateEntityQuery({ schema: schema.schema, entityName: params.entity, decision, query: body });
    } catch (e: any) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(String(e?.message ?? e));
    }

    if (body.cursor && body.orderBy && !(body.orderBy.length === 1 && body.orderBy[0].field === "updatedAt" && body.orderBy[0].direction === "desc")) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("cursor 仅支持 orderBy=updatedAt desc");
    }

    const limit = body.limit ?? 50;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}` },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };
    const { items, nextCursor } = await queryRecords({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      entityName: params.entity,
      limit,
      filters: body.filters,
      orderBy: body.orderBy,
      cursor: body.cursor,
      select: body.select,
      fieldTypes,
      subjectId: subject.subjectId,
      rowFilters: decision.rowFilters ?? null,
      policyContext,
    });

    const pick = (payload: any) => {
      if (!body.select || body.select.length === 0) return payload;
      const out: any = {};
      for (const k of body.select) if (payload && Object.prototype.hasOwnProperty.call(payload, k)) out[k] = payload[k];
      return out;
    };

    const filteredItems = items.map((r) => {
      const readable = applyReadFieldRules(r.payload ?? {}, decision);
      return { ...r, payload: pick(readable) };
    });

    const filtersDigest = crypto.createHash("sha256").update(JSON.stringify(body.filters ?? null)).digest("hex");
    req.ctx.audit!.inputDigest = {
      entityName: params.entity,
      schemaName,
      limit,
      hasCursor: Boolean(body.cursor),
      selectCount: body.select?.length ?? 0,
      orderBy: body.orderBy ?? [],
      filtersDigest,
    };
    req.ctx.audit!.outputDigest = { count: filteredItems.length, hasNext: Boolean(nextCursor) };

    return {
      items: filteredItems,
      nextCursor,
      summary: { filtersDigest, orderBy: body.orderBy ?? [], limit },
    };
  });

  app.post("/entities/:entity/export", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "entity", action: "export" });
    const decision = await requirePermission({ req, resourceType: "entity", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = entityQueryRequestSchema
      .extend({
        format: z.enum(["jsonl", "json"]).optional(),
      })
      .parse(req.body);
    const schemaName = body.schemaName ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);
    if (!schema.schema.entities?.[params.entity]) throw Errors.badRequest("实体不存在");

    try {
      validateEntityQuery({ schema: schema.schema, entityName: params.entity, decision, query: body });
    } catch (e: any) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(String(e?.message ?? e));
    }

    const runToolRef = `entity.export:${params.entity}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "entity.export",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      input: {
        kind: "entity.export",
        entityName: params.entity,
        schemaName,
        query: { filters: body.filters, orderBy: body.orderBy, cursor: body.cursor, limit: body.limit },
        select: body.select ?? null,
        format: body.format ?? "jsonl",
        fieldRules: decision.fieldRules ?? null,
        rowFilters: decision.rowFilters ?? null,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
        limits: (req.body as any)?.limits,
        networkPolicy: (req.body as any)?.networkPolicy,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = { runId: run.runId, stepId: step.stepId, jobId: job.jobId, format: body.format ?? "jsonl" };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, receipt };
  });

  app.post("/entities/:entity/import", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "entity", action: "import" });
    const decision = await requirePermission({ req, resourceType: "entity", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = z
      .object({
        schemaName: z.string().min(1).optional(),
        format: z.enum(["jsonl", "json"]).optional(),
        mode: z.enum(["dry_run", "commit"]).optional(),
        records: z.array(z.record(z.string(), z.any())).max(500),
      })
      .parse(req.body);

    const schemaName = body.schemaName ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);
    if (!schema.schema.entities?.[params.entity]) throw Errors.badRequest("实体不存在");

    const mode = body.mode ?? "dry_run";
    const format = body.format ?? "jsonl";
    const contentBytes = Buffer.byteLength(JSON.stringify(body.records ?? []), "utf8");
    if (contentBytes > 1024 * 1024) throw Errors.badRequest("records 过大");

    if (mode === "dry_run") {
      let accepted = 0;
      let rejected = 0;
      const reasons: Record<string, number> = {};
      for (const raw of body.records) {
        try {
          const payload = applyWriteFieldRules(raw, decision);
          const validation = validateEntityPayload({ schema: schema.schema, entityName: params.entity, payload });
          if (!validation.ok) throw new Error(validation.reason);
          accepted += 1;
        } catch (e: any) {
          rejected += 1;
          const key = String(e?.message ?? e ?? "invalid");
          reasons[key] = (reasons[key] ?? 0) + 1;
        }
      }
      const reasonsDigest = crypto.createHash("sha256").update(JSON.stringify(reasons)).digest("hex");
      req.ctx.audit!.outputDigest = { mode, accepted, rejected, reasonsDigest };
      return { mode, acceptedCount: accepted, rejectedCount: rejected, reasonsDigest };
    }

    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined);
    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    const runToolRef = `entity.import:${params.entity}`;
    const { job, run, step } = await createJobRunStepWithoutToolRef({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "entity.import",
      runToolRef,
      policySnapshotRef: decision.snapshotRef,
      idempotencyKey,
      input: {
        kind: "entity.import",
        entityName: params.entity,
        schemaName,
        format,
        records: body.records,
        fieldRules: decision.fieldRules ?? null,
        rowFilters: decision.rowFilters ?? null,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
        limits: (req.body as any)?.limits,
        networkPolicy: (req.body as any)?.networkPolicy,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
    });

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = { runId: run.runId, stepId: step.stepId, jobId: job.jobId, mode, format };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, receipt };
  });

  app.post("/entities/:entity", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined);
    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    setAuditContext(req, { resourceType: "entity", action: "create", idempotencyKey, requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "entity", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}` },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };
    const prior = await getIdempotencyRecord({
      pool: app.db,
      tenantId: subject.tenantId,
      idempotencyKey,
      operation: "create",
      entityName: params.entity,
    });
    if (prior?.recordId) {
      const rec = await getRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: params.entity,
        id: prior.recordId,
        subjectId: subject.subjectId,
        rowFilters: decision.rowFilters ?? null,
        policyContext: { ...policyContext, resource: { type: `entity:${params.entity}`, id: prior.recordId } },
      });
      if (rec) {
        req.ctx.audit!.requireOutbox = false;
        req.ctx.audit!.outputDigest = { recordId: rec.id, idempotentReplay: true };
        return { ...rec, payload: applyReadFieldRules(rec.payload ?? {}, decision) };
      }
    }

    const schemaName = (req.headers["x-schema-name"] as string | undefined) ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);

    const rawPayload = z.record(z.string(), z.any()).parse(req.body);
    let payload: any = rawPayload;
    try {
      payload = applyWriteFieldRules(rawPayload, decision);
    } catch (e: any) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.fieldWriteForbidden();
    }
    const validation = validateEntityPayload({ schema: schema.schema, entityName: params.entity, payload });
    if (!validation.ok) throw Errors.badRequest(validation.reason);
    const refValidation = await validateReferenceFields({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, schema: schema.schema, entityName: params.entity, payload });
    if (!refValidation.ok) throw Errors.badRequest(refValidation.reason);
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const rec = await insertRecord({
        pool: client,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: params.entity,
        schemaName: schema.name,
        schemaVersion: schema.version,
        payload,
        ownerSubjectId: subject.subjectId,
      });

      await insertIdempotencyRecord({
        pool: client,
        tenantId: subject.tenantId,
        idempotencyKey,
        operation: "create",
        entityName: params.entity,
        recordId: rec.id,
      });

      req.ctx.audit!.outputDigest = { recordId: rec.id };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { ...rec, payload: applyReadFieldRules(rec.payload ?? {}, decision) };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.patch("/entities/:entity/:id", async (req, reply) => {
    const params = z.object({ entity: z.string(), id: z.string() }).parse(req.params);
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined);
    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    setAuditContext(req, { resourceType: "entity", action: "update", idempotencyKey, requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "entity", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}`, id: params.id },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };

    const prior = await getIdempotencyRecord({
      pool: app.db,
      tenantId: subject.tenantId,
      idempotencyKey,
      operation: "update",
      entityName: params.entity,
    });
    if (prior?.recordId) {
      const rec = await getRecord({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: params.entity,
        id: prior.recordId,
        subjectId: subject.subjectId,
        rowFilters: decision.rowFilters ?? null,
        policyContext: { ...policyContext, resource: { type: `entity:${params.entity}`, id: prior.recordId } },
      });
      if (rec) {
        req.ctx.audit!.requireOutbox = false;
        req.ctx.audit!.outputDigest = { recordId: rec.id, idempotentReplay: true };
        return { ...rec, payload: applyReadFieldRules(rec.payload ?? {}, decision) };
      }
    }

    const expectedRevision = (req.headers["if-match-revision"] as string | undefined)
      ? Number(req.headers["if-match-revision"])
      : undefined;
    const patchRaw = z.record(z.string(), z.any()).parse(req.body);
    let patch: any = patchRaw;
    try {
      patch = applyWriteFieldRules(patchRaw, decision);
    } catch (e: any) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.fieldWriteForbidden();
    }
    const schemaName = (req.headers["x-schema-name"] as string | undefined) ?? "core";
    const schema = await getEffectiveSchema({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: schemaName });
    if (!schema) throw Errors.badRequest(`Schema 未发布：${schemaName}`);
    const refValidation = await validateReferenceFields({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, schema: schema.schema, entityName: params.entity, payload: patch });
    if (!refValidation.ok) throw Errors.badRequest(refValidation.reason);
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const updatedTx = await updateRecord({
        pool: client,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: params.entity,
        id: params.id,
        patch,
        expectedRevision,
        subjectId: subject.subjectId,
        rowFilters: decision.rowFilters ?? null,
        policyContext,
      });
      if (!updatedTx) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ errorCode: "CONFLICT", message: { "zh-CN": "并发冲突或记录不存在", "en-US": "Conflict or not found" }, traceId: req.ctx.traceId });
      }

      await insertIdempotencyRecord({
        pool: client,
        tenantId: subject.tenantId,
        idempotencyKey,
        operation: "update",
        entityName: params.entity,
        recordId: updatedTx.id,
      });

      req.ctx.audit!.outputDigest = { recordId: updatedTx.id };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { ...updatedTx, payload: applyReadFieldRules(updatedTx.payload ?? {}, decision) };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.delete("/entities/:entity/:id", async (req, reply) => {
    const params = z.object({ entity: z.string(), id: z.string() }).parse(req.params);
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined);
    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    setAuditContext(req, { resourceType: "entity", action: "delete", idempotencyKey, requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "entity", action: "delete" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const policyContext = {
      subject: { id: subject.subjectId },
      tenant: { id: subject.tenantId },
      space: { id: subject.spaceId ?? null },
      request: { method: req.method, path: req.url, traceId: req.ctx.traceId },
      resource: { type: `entity:${params.entity}`, id: params.id },
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
    };

    const prior = await getIdempotencyRecord({
      pool: app.db,
      tenantId: subject.tenantId,
      idempotencyKey,
      operation: "delete",
      entityName: params.entity,
    });
    if (prior?.recordId) {
      req.ctx.audit!.requireOutbox = false;
      req.ctx.audit!.outputDigest = { recordId: prior.recordId, deleted: true, idempotentReplay: true };
      return { id: prior.recordId, recordId: prior.recordId, deleted: true };
    }

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const deletedTx = await deleteRecord({
        pool: client,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        entityName: params.entity,
        id: params.id,
        subjectId: subject.subjectId,
        rowFilters: decision.rowFilters ?? null,
        policyContext,
      });
      if (!deletedTx) {
        await insertIdempotencyRecord({
          pool: client,
          tenantId: subject.tenantId,
          idempotencyKey,
          operation: "delete",
          entityName: params.entity,
          recordId: params.id,
        });
        req.ctx.audit!.outputDigest = { recordId: params.id, deleted: true, notFound: true };
        await enqueueAuditOutboxForRequest({ client, req });
        await client.query("COMMIT");
        return { id: params.id, recordId: params.id, deleted: true, notFound: true };
      }

      await insertIdempotencyRecord({
        pool: client,
        tenantId: subject.tenantId,
        idempotencyKey,
        operation: "delete",
        entityName: params.entity,
        recordId: deletedTx.id,
      });

      req.ctx.audit!.outputDigest = { recordId: deletedTx.id, deleted: true };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { ...deletedTx, payload: applyReadFieldRules(deletedTx.payload ?? {}, decision), deleted: true };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });
};
