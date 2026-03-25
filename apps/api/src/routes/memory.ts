import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { clearMemory, createMemoryEntry, deleteMemoryEntry, exportAndClearMemory, getTaskState, listMemoryEntries, searchMemory, upsertTaskState } from "../modules/memory/repo";
import { clearSessionContext, getSessionContext, upsertSessionContext } from "../modules/memory/sessionContextRepo";

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  app.post("/memory/entries", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        scope: z.enum(["user", "space"]),
        type: z.string().min(1),
        title: z.string().min(1).optional(),
        contentText: z.string().min(1),
        retentionDays: z.number().int().positive().max(365).optional(),
        writePolicy: z.enum(["confirmed", "approved", "policyAllowed"]),
        sourceRef: z.any().optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { scope: body.scope, type: body.type, titleLen: body.title?.length ?? 0, contentLen: body.contentText.length, retentionDays: body.retentionDays, writePolicy: body.writePolicy };

    const ownerSubjectId = body.scope === "user" ? subject.subjectId : null;
    const expiresAt = body.retentionDays ? new Date(Date.now() + body.retentionDays * 24 * 60 * 60 * 1000).toISOString() : null;
    const created = await createMemoryEntry({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      ownerSubjectId,
      scope: body.scope,
      type: body.type,
      title: body.title ?? null,
      contentText: body.contentText,
      retentionDays: body.retentionDays ?? null,
      expiresAt,
      writePolicy: body.writePolicy,
      sourceRef: body.sourceRef ?? { kind: "conversation" },
    });

    req.ctx.audit!.outputDigest = { id: created.entry.id, scope: created.entry.scope, type: created.entry.type, dlpSummary: created.dlpSummary };
    return { entry: { id: created.entry.id, scope: created.entry.scope, type: created.entry.type, title: created.entry.title, createdAt: created.entry.createdAt } };
  });

  app.get("/memory/entries", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const q = z
      .object({
        scope: z.enum(["user", "space"]).optional(),
        type: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const entries = await listMemoryEntries({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      scope: q.scope,
      type: q.type,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });

    req.ctx.audit!.outputDigest = { count: entries.length, scope: q.scope, type: q.type };
    return {
      entries: entries.map((e) => ({ id: e.id, scope: e.scope, type: e.type, title: e.title, createdAt: e.createdAt })),
    };
  });

  app.post("/memory/search", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        query: z.string().min(1),
        scope: z.enum(["user", "space"]).optional(),
        types: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().max(20).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { queryLen: body.query.length, scope: body.scope, types: body.types?.slice(0, 10), limit: body.limit ?? 5 };
    const r = await searchMemory({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      query: body.query,
      scope: body.scope,
      types: body.types,
      limit: body.limit ?? 5,
    });
    req.ctx.audit!.outputDigest = { candidateCount: r.evidence.length, types: [...new Set(r.evidence.map((e) => e.type))].slice(0, 10) };
    return { evidence: r.evidence, candidateCount: r.evidence.length };
  });

  app.delete("/memory/entries/:id", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "delete" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const ok = await deleteMemoryEntry({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, id: params.id });

    req.ctx.audit!.outputDigest = { id: params.id, deleted: ok };
    return { deleted: ok };
  });

  app.post("/memory/clear", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "clear" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "clear" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z.object({ scope: z.enum(["user", "space"]) }).parse(req.body);
    const count = await clearMemory({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, scope: body.scope });

    req.ctx.audit!.outputDigest = { scope: body.scope, deletedCount: count };
    return { deletedCount: count };
  });

  app.post("/memory/export-clear", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "clear" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "clear" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        scope: z.enum(["user", "space"]),
        types: z.array(z.string().min(1)).max(50).optional(),
        limit: z.number().int().positive().max(5000).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { scope: body.scope, typeCount: body.types?.length ?? 0, limit: body.limit ?? 1000, redacted: true };
    const out = await exportAndClearMemory({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      scope: body.scope,
      types: body.types,
      limit: body.limit ?? 1000,
    });
    req.ctx.audit!.outputDigest = { scope: body.scope, exportedCount: out.entries.length, deletedCount: out.deletedCount, redacted: true };
    return {
      scope: body.scope,
      exportedCount: out.entries.length,
      deletedCount: out.deletedCount,
      entries: out.entries.map((e) => ({ id: e.id, scope: e.scope, type: e.type, title: e.title, contentText: e.contentText, createdAt: e.createdAt })),
    };
  });

  app.get("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length };

    const ctx = await getSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, found: Boolean(ctx), messageCount: ctx?.context.messages.length ?? 0, expiresAt: ctx?.expiresAt ?? null };
    return { sessionContext: ctx };
  });

  app.put("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    const body = z
      .object({
        context: z.object({
          v: z.literal(1),
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant", "system"]),
                content: z.string().min(1).max(20_000),
                at: z.string().min(1).optional(),
              }),
            )
            .max(200),
        }),
        expiresAt: z.string().min(1).optional(),
        retentionDays: z.number().int().positive().max(365).optional(),
      })
      .parse(req.body);

    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const ms = Date.parse(body.expiresAt);
      if (!Number.isFinite(ms)) throw Errors.badRequest("expiresAt 非法");
      expiresAt = new Date(ms).toISOString();
    } else if (body.retentionDays) {
      expiresAt = new Date(Date.now() + body.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const messageCount = body.context.messages.length;
    const totalChars = body.context.messages.reduce((acc, m) => acc + m.content.length, 0);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length, messageCount, totalChars, expiresAt, retentionDays: body.retentionDays ?? null, expiresAtProvided: Boolean(body.expiresAt) };

    const row = await upsertSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
      context: body.context,
      expiresAt,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, updatedAt: row.updatedAt, expiresAt: row.expiresAt ?? null };
    return { sessionContext: { sessionId: row.sessionId, expiresAt: row.expiresAt ?? null, updatedAt: row.updatedAt } };
  });

  app.delete("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "delete" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length };

    const cleared = await clearSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, cleared };
    return { cleared };
  });

  app.put("/memory/task-states/:runId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "task_state" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "task_state" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ runId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        stepId: z.string().uuid().optional(),
        phase: z.string().min(1),
        plan: z.any().optional(),
        artifactsDigest: z.any().optional(),
      })
      .parse(req.body);

    const r = await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      stepId: body.stepId ?? null,
      phase: body.phase,
      plan: body.plan,
      artifactsDigest: body.artifactsDigest,
    });

    req.ctx.audit!.outputDigest = { runId: params.runId, phase: r.taskState.phase, dlpSummary: r.dlpSummary };
    return { taskState: r.taskState };
  });

  app.get("/memory/task-states/:runId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ runId: z.string().uuid() }).parse(req.params);
    const ts = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: params.runId });
    return { taskState: ts };
  });
};
