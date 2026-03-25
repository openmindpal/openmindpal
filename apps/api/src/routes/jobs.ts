import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { createJobRunStep, getJob, getRunForSpace, listSteps } from "../modules/workflow/jobRepo";

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post("/jobs/entities/:entity/create", async (req) => {
    const params = z.object({ entity: z.string() }).parse(req.params);
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined);
    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    setAuditContext(req, { resourceType: "workflow", action: "create", idempotencyKey, toolRef: "workflow:entity.create" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = z.record(z.string(), z.any()).parse(req.body);
    const schemaName = (req.headers["x-schema-name"] as string | undefined) ?? "core";

    const toolRef = `tool:entity.create:${params.entity}`;
    const { job, run, step } = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "entity.create",
      toolRef,
      policySnapshotRef: decision.snapshotRef,
      idempotencyKey,
      createdBySubjectId: subject.subjectId,
      trigger: "manual",
      masterKey: app.cfg.secrets.masterKey,
      input: {
        schemaName,
        entityName: params.entity,
        payload: body,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
    });

    await app.queue.add(
      "step",
      { jobId: job.jobId, runId: run.runId, stepId: step.stepId },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
    );

    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId };
  });

  app.get("/jobs/:jobId", async (req, reply) => {
    const params = z.object({ jobId: z.string() }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const job = await getJob(app.db, subject.tenantId, params.jobId);
    if (!job) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "作业不存在", "en-US": "Job not found" }, traceId: req.ctx.traceId });

    if (job.runId) {
      const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, job.runId);
      if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "作业不存在", "en-US": "Job not found" }, traceId: req.ctx.traceId });
    }
    const steps = job.runId ? await listSteps(app.db, job.runId) : [];
    return { job, steps };
  });
};
