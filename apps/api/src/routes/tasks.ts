import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { appendAgentMessage, listAgentMessagesByTask } from "../modules/tasks/agentMessageRepo";
import { createTask, getTask, listLongTasks, listRunsByTask, listTasks } from "../modules/tasks/taskRepo";
import { insertAuditEvent } from "../modules/audit/auditRepo";

export const taskRoutes: FastifyPluginAsync = async (app) => {
  app.post("/tasks", async (req) => {
    setAuditContext(req, { resourceType: "task", action: "create" });
    const decision = await requirePermission({ req, resourceType: "task", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z.object({ title: z.string().max(200).optional() }).parse(req.body);
    const task = await createTask({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, createdBySubjectId: subject.subjectId, title: body.title ?? null });
    req.ctx.audit!.outputDigest = { taskId: task.taskId, status: task.status };
    return { task };
  });

  app.get("/tasks", async (req) => {
    setAuditContext(req, { resourceType: "task", action: "read" });
    const decision = await requirePermission({ req, resourceType: "task", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional(), scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const spaceId = q.scope === "tenant" ? null : (subject.spaceId ?? null);
    const tasks = await listTasks({ pool: app.db, tenantId: subject.tenantId, spaceId, limit: q.limit ?? 20, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: tasks.length, limit: q.limit ?? 20, offset: q.offset ?? 0, scope: q.scope ?? "space" };
    return { tasks };
  });

  app.get("/tasks/long-tasks", async (req) => {
    setAuditContext(req, { resourceType: "task", action: "read" });
    const decision = await requirePermission({ req, resourceType: "task", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        scope: z.enum(["tenant", "space"]).optional(),
      })
      .parse(req.query);
    const spaceId = q.scope === "tenant" ? null : (subject.spaceId ?? null);
    const items = await listLongTasks({ pool: app.db, tenantId: subject.tenantId, spaceId, limit: q.limit ?? 20, offset: q.offset ?? 0 });
    const longTasks = items.map((it) => {
      const latest = it.latest;
      const needsApproval = latest?.status === "needs_approval";
      const canCancel = Boolean(latest?.runId && (latest.status === "created" || latest.status === "queued" || latest.status === "running" || latest.status === "needs_approval"));
      const canContinue = Boolean(latest?.runId && latest.jobType === "agent.run" && latest.status === "needs_approval");
      return {
        task: it.task,
        run: latest
          ? {
              runId: latest.runId,
              status: latest.status,
              jobType: latest.jobType,
              toolRef: latest.toolRef,
              traceId: latest.traceId,
              startedAt: latest.startedAt,
              finishedAt: latest.finishedAt,
              updatedAt: latest.updatedAt,
            }
          : null,
        progress: { phase: latest?.phase ?? null },
        controls: { canCancel, canContinue, needsApproval },
      };
    });
    req.ctx.audit!.outputDigest = { count: longTasks.length, limit: q.limit ?? 20, offset: q.offset ?? 0, scope: q.scope ?? "space" };
    return { longTasks };
  });

  app.get("/tasks/:taskId", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "task", action: "read" });
    const decision = await requirePermission({ req, resourceType: "task", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const runs = await listRunsByTask({ pool: app.db, tenantId: subject.tenantId, taskId: task.taskId, limit: 20 });
    req.ctx.audit!.outputDigest = { taskId: task.taskId, runCount: runs.length };
    return { task, runs };
  });

  app.post("/tasks/:taskId/messages", async (req) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "task", action: "message.append" });
    const decision = await requirePermission({ req, resourceType: "task", action: "message.append" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const existing = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!existing) throw Errors.badRequest("Task 不存在");
    if (existing.spaceId && existing.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        from: z.object({ agentId: z.string().max(200).optional(), role: z.string().min(1).max(50) }),
        intent: z.enum(["plan", "retrieve", "execute", "review", "observe", "respond", "handoff"]),
        correlation: z.record(z.string(), z.any()).optional(),
        inputs: z.record(z.string(), z.any()).optional(),
        outputs: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    if (body.intent === "respond" && body.from.role !== "human") {
      const recent = await listAgentMessagesByTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId, limit: 50, before: null });
      const retrievalUsed = recent.some((m: any) => {
        if (String(m?.intent ?? "") !== "retrieve") return false;
        const o = m?.outputs;
        const i = m?.inputs;
        const hasEv = (o && typeof o === "object" && Array.isArray((o as any).evidenceRefs) && (o as any).evidenceRefs.length > 0) || (i && typeof i === "object" && Array.isArray((i as any).evidenceRefs) && (i as any).evidenceRefs.length > 0);
        const hasLog = (o && typeof o === "object" && typeof (o as any).retrievalLogId === "string" && String((o as any).retrievalLogId).length > 0) || (i && typeof i === "object" && typeof (i as any).retrievalLogId === "string" && String((i as any).retrievalLogId).length > 0);
        return hasEv || hasLog;
      });
      if (retrievalUsed) {
        const evOut = body.outputs && Array.isArray((body.outputs as any).evidenceRefs) ? ((body.outputs as any).evidenceRefs as any[]) : [];
        const evIn = body.inputs && Array.isArray((body.inputs as any).evidenceRefs) ? ((body.inputs as any).evidenceRefs as any[]) : [];
        const evidenceRefsCount = evOut.length + evIn.length;
        const retrievalLogId =
          (body.outputs && typeof (body.outputs as any).retrievalLogId === "string" ? String((body.outputs as any).retrievalLogId) : "") ||
          (body.inputs && typeof (body.inputs as any).retrievalLogId === "string" ? String((body.inputs as any).retrievalLogId) : "");

        if (evidenceRefsCount <= 0) {
          await insertAuditEvent(app.db, {
            subjectId: subject.subjectId,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId ?? undefined,
            resourceType: "knowledge",
            action: "answer.denied",
            inputDigest: { taskId: params.taskId, intent: body.intent, retrievalUsed: true, retrievalLogId: retrievalLogId || null },
            outputDigest: { reason: "missing_evidence" },
            result: "denied",
            traceId: req.ctx.traceId,
            requestId: req.ctx.requestId,
            errorCategory: "policy_violation",
          });
          req.ctx.audit!.errorCategory = "policy_violation";
          throw Errors.evidenceRequired();
        }
        await insertAuditEvent(app.db, {
          subjectId: subject.subjectId,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId ?? undefined,
          resourceType: "knowledge",
          action: "answer",
          inputDigest: { taskId: params.taskId, intent: body.intent, retrievalUsed: true, retrievalLogId: retrievalLogId || null },
          outputDigest: { evidenceRefsCount },
          result: "success",
          traceId: req.ctx.traceId,
          requestId: req.ctx.requestId,
        });
      }
    }

    const message = await appendAgentMessage({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      taskId: params.taskId,
      fromAgentId: body.from.agentId ?? null,
      fromRole: body.from.role,
      intent: body.intent,
      correlation: body.correlation ?? null,
      inputs: body.inputs ?? null,
      outputs: body.outputs ?? null,
    });
    req.ctx.audit!.outputDigest = { taskId: params.taskId, messageId: message.messageId, role: message.from.role, intent: message.intent };
    return { message };
  });

  app.get("/tasks/:taskId/messages", async (req) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "task", action: "message.read" });
    const decision = await requirePermission({ req, resourceType: "task", action: "message.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const existing = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!existing) throw Errors.badRequest("Task 不存在");
    if (existing.spaceId && existing.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional(), before: z.string().optional() }).parse(req.query);
    const messages = await listAgentMessagesByTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId, limit: q.limit ?? 50, before: q.before ?? null });
    req.ctx.audit!.outputDigest = { taskId: params.taskId, count: messages.length };
    return { messages };
  });
};
