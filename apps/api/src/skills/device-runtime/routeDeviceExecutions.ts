import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { getDevicePolicy } from "./modules/devicePolicyRepo";
import { getDeviceRecord } from "./modules/deviceRepo";
import { cancelDeviceExecution, claimDeviceExecution, completeDeviceExecution, createDeviceExecution, getDeviceExecution, listDeviceExecutions, listPendingByDevice } from "./modules/deviceExecutionRepo";
import { getToolDefinition, getToolVersionByRef } from "../../modules/tools/toolRepo";
import { validateToolInput } from "../../modules/tools/validate";
import { sha256Hex } from "../../lib/digest";

function requireDevice(req: any) {
  const device = req.ctx.device;
  if (!device) throw Errors.unauthorized(req.ctx.locale);
  return device as { deviceId: string; tenantId: string; spaceId: string | null; ownerScope: string; ownerSubjectId: string | null };
}

function digestObject(v: any) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  return { keyCount: keys.length, keys: keys.slice(0, 50) };
}

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  if (idx <= 0) return toolRef;
  return toolRef.slice(0, idx);
}

function digestPolicy(policy: any) {
  const allowedTools = Array.isArray(policy?.allowedTools) ? policy.allowedTools.map((x: any) => String(x)).filter(Boolean).sort() : [];
  const allowedRoots = Array.isArray(policy?.filePolicy?.allowedRoots) ? policy.filePolicy.allowedRoots.map((x: any) => String(x)).filter(Boolean).sort() : [];
  const allowedDomains = Array.isArray(policy?.networkPolicy?.allowedDomains) ? policy.networkPolicy.allowedDomains.map((x: any) => String(x)).filter(Boolean).sort() : [];
  const allowedTypes = Array.isArray(policy?.evidencePolicy?.allowedTypes) ? policy.evidencePolicy.allowedTypes.map((x: any) => String(x)).filter(Boolean).sort() : [];
  return {
    allowedToolsCount: allowedTools.length,
    allowedToolsSha256_8: sha256Hex(allowedTools.join("\n")).slice(0, 8),
    allowedRootsCount: allowedRoots.length,
    allowedRootsSha256_8: sha256Hex(allowedRoots.join("\n")).slice(0, 8),
    allowedDomainsCount: allowedDomains.length,
    allowedDomainsSha256_8: sha256Hex(allowedDomains.join("\n")).slice(0, 8),
    uiPolicyEnabled: Boolean(policy?.uiPolicy),
    evidenceUploadEnabled: Boolean(policy?.evidencePolicy?.allowUpload),
    evidenceAllowedTypesCount: allowedTypes.length,
    evidenceAllowedTypesSha256_8: sha256Hex(allowedTypes.join("\n")).slice(0, 8),
  };
}

function toPublicExecution(e: any) {
  return {
    deviceExecutionId: e.deviceExecutionId,
    tenantId: e.tenantId,
    spaceId: e.spaceId ?? null,
    createdBySubjectId: e.createdBySubjectId ?? null,
    deviceId: e.deviceId,
    toolRef: e.toolRef,
    policySnapshotRef: e.policySnapshotRef ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    requireUserPresence: Boolean(e.requireUserPresence),
    inputDigest: e.inputDigest ?? null,
    status: e.status,
    outputDigest: e.outputDigest ?? null,
    evidenceRefs: e.evidenceRefs ?? null,
    errorCategory: e.errorCategory ?? null,
    claimedAt: e.claimedAt ?? null,
    completedAt: e.completedAt ?? null,
    canceledAt: e.canceledAt ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function toDeviceExecution(e: any) {
  return {
    deviceExecutionId: e.deviceExecutionId,
    toolRef: e.toolRef,
    requireUserPresence: Boolean(e.requireUserPresence),
    input: e.inputJson ?? null,
    inputDigest: e.inputDigest ?? null,
    status: e.status,
    createdAt: e.createdAt,
  };
}

export const deviceExecutionRoutes: FastifyPluginAsync = async (app) => {
  app.post("/device-executions", async (req) => {
    setAuditContext(req, { resourceType: "device_execution", action: "create" });
    const decision = await requirePermission({ req, resourceType: "device_execution", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        deviceId: z.string().uuid(),
        toolRef: z.string().min(3).max(200),
        policySnapshotRef: z.string().min(1).max(200).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        requireUserPresence: z.boolean().optional(),
        input: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    const device = await getDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: body.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    if (device.status !== "active") throw Errors.badRequest("Device 未激活");
    if ((subject.spaceId ?? null) !== (device.spaceId ?? null)) throw Errors.forbidden();

    const ver = await getToolVersionByRef(app.db, subject.tenantId, body.toolRef);
    if (!ver || ver.status !== "released") throw Errors.badRequest("toolRef 未发布");
    try {
      validateToolInput(ver.inputSchema, body.input ?? {});
    } catch (e: any) {
      const zh = typeof e?.messageI18n?.["zh-CN"] === "string" ? String(e.messageI18n["zh-CN"]) : "";
      throw Errors.inputSchemaInvalid(zh || undefined);
    }

    const name = toolName(body.toolRef);
    const policy = await getDevicePolicy({ pool: app.db, tenantId: subject.tenantId, deviceId: device.deviceId });
    const allowedTools = policy?.allowedTools ?? null;
    if (!allowedTools || !Array.isArray(allowedTools) || allowedTools.length === 0) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (!allowedTools.includes(name)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const def = await getToolDefinition(app.db, subject.tenantId, name);
    const opResourceType = def?.resourceType ?? null;
    const opAction = def?.action ?? null;
    const riskLevel = (def as any)?.riskLevel ?? "low";
    if (!opResourceType || !opAction) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("工具契约缺失");
    }
    const opDecision = await requirePermission({ req, resourceType: opResourceType, action: opAction });
    const policySnapshotRef = opDecision.snapshotRef ?? null;
    if (!policySnapshotRef) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("缺少 policySnapshotRef");
    }

    const requireUserPresence =
      body.requireUserPresence === undefined || body.requireUserPresence === null
        ? String(riskLevel) !== "low"
        : Boolean(body.requireUserPresence);

    const created = await createDeviceExecution({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: device.spaceId ?? null,
      createdBySubjectId: subject.subjectId,
      deviceId: device.deviceId,
      toolRef: body.toolRef,
      policySnapshotRef,
      idempotencyKey: body.idempotencyKey ?? null,
      requireUserPresence,
      inputJson: body.input ?? null,
      inputDigest: digestObject(body.input ?? null),
    });

    req.ctx.audit!.outputDigest = {
      deviceExecutionId: created.deviceExecutionId,
      deviceId: created.deviceId,
      toolRef: created.toolRef,
      status: created.status,
      inputDigest: created.inputDigest,
      policySnapshotRef,
      requireUserPresence,
    };
    return { execution: toPublicExecution(created) };
  });

  app.get("/device-executions", async (req) => {
    setAuditContext(req, { resourceType: "device_execution", action: "read" });
    const decision = await requirePermission({ req, resourceType: "device_execution", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z
      .object({
        deviceId: z.string().uuid().optional(),
        status: z.enum(["pending", "claimed", "succeeded", "failed", "canceled"]).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const list = await listDeviceExecutions({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? undefined,
      deviceId: q.deviceId,
      status: q.status,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });
    req.ctx.audit!.outputDigest = { count: list.length, limit: q.limit ?? 20, offset: q.offset ?? 0 };
    return { executions: list.map(toPublicExecution) };
  });

  app.get("/device-executions/:deviceExecutionId", async (req, reply) => {
    const params = z.object({ deviceExecutionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device_execution", action: "read" });
    const decision = await requirePermission({ req, resourceType: "device_execution", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const e = await getDeviceExecution({ pool: app.db, tenantId: subject.tenantId, deviceExecutionId: params.deviceExecutionId });
    if (!e) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "DeviceExecution 不存在", "en-US": "DeviceExecution not found" }, traceId: req.ctx.traceId });
    if ((subject.spaceId ?? null) !== (e.spaceId ?? null)) throw Errors.forbidden();
    return { execution: toPublicExecution(e) };
  });

  app.post("/device-executions/:deviceExecutionId/cancel", async (req) => {
    const params = z.object({ deviceExecutionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device_execution", action: "cancel" });
    const decision = await requirePermission({ req, resourceType: "device_execution", action: "cancel" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const e = await getDeviceExecution({ pool: app.db, tenantId: subject.tenantId, deviceExecutionId: params.deviceExecutionId });
    if (!e) throw Errors.badRequest("DeviceExecution 不存在");
    if ((subject.spaceId ?? null) !== (e.spaceId ?? null)) throw Errors.forbidden();
    const canceled = await cancelDeviceExecution({ pool: app.db, tenantId: subject.tenantId, deviceExecutionId: params.deviceExecutionId });
    if (!canceled) throw Errors.badRequest("DeviceExecution 不存在或不可取消");
    req.ctx.audit!.outputDigest = { deviceExecutionId: canceled.deviceExecutionId, status: canceled.status };
    return { execution: toPublicExecution(canceled) };
  });

  app.get("/device-agent/executions/pending", async (req) => {
    setAuditContext(req, { resourceType: "device_execution", action: "device.poll" });
    const device = requireDevice(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(50).optional() }).parse(req.query);
    const items = await listPendingByDevice({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId, limit: q.limit ?? 20 });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, count: items.length };
    return { executions: items.map(toDeviceExecution) };
  });

  app.post("/device-agent/executions/:deviceExecutionId/claim", async (req) => {
    const params = z.object({ deviceExecutionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device_execution", action: "device.claim" });
    const device = requireDevice(req);

    const existing = await getDeviceExecution({ pool: app.db, tenantId: device.tenantId, deviceExecutionId: params.deviceExecutionId });
    if (!existing) throw Errors.badRequest("DeviceExecution 不存在");
    if (existing.deviceId !== device.deviceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    const allowedTools = policy?.allowedTools ?? null;
    const name = toolName(existing.toolRef);
    if (!allowedTools || !Array.isArray(allowedTools) || allowedTools.length === 0) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (allowedTools && !allowedTools.includes(name)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const claimed = await claimDeviceExecution({ pool: app.db, tenantId: device.tenantId, deviceExecutionId: params.deviceExecutionId, deviceId: device.deviceId });
    if (!claimed) throw Errors.badRequest("DeviceExecution 不存在或不可领取");
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, deviceExecutionId: claimed.deviceExecutionId, toolRef: claimed.toolRef, status: claimed.status, requireUserPresence: claimed.requireUserPresence };
    const policyDigest = digestPolicy(policy);
    return { execution: toDeviceExecution(claimed), requireUserPresence: claimed.requireUserPresence, policy, policyDigest };
  });

  app.post("/device-agent/executions/:deviceExecutionId/result", async (req) => {
    const params = z.object({ deviceExecutionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device_execution", action: "device.result" });
    const device = requireDevice(req);
    const body = z
      .object({
        status: z.enum(["succeeded", "failed"]),
        outputDigest: z.record(z.string(), z.any()).optional(),
        errorCategory: z.string().min(1).max(50).optional(),
        evidenceRefs: z.array(z.string()).max(50).optional(),
      })
      .parse(req.body);

    const existing = await getDeviceExecution({ pool: app.db, tenantId: device.tenantId, deviceExecutionId: params.deviceExecutionId });
    if (!existing) throw Errors.badRequest("DeviceExecution 不存在");
    if (existing.deviceId !== device.deviceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    const evidencePolicy = policy?.evidencePolicy ? String(policy.evidencePolicy) : "none";
    const evCount = body.evidenceRefs?.length ?? 0;
    if (body.status === "succeeded" && evidencePolicy === "required" && evCount <= 0) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.evidenceRequired();
    }

    const done = await completeDeviceExecution({
      pool: app.db,
      tenantId: device.tenantId,
      deviceExecutionId: params.deviceExecutionId,
      deviceId: device.deviceId,
      status: body.status,
      outputDigest: body.outputDigest ?? null,
      errorCategory: body.errorCategory ?? null,
      evidenceRefs: body.evidenceRefs ?? null,
    });
    if (!done) throw Errors.badRequest("DeviceExecution 不存在或不可回传");

    // ── 实时恢复关联的工作流步骤 ──
    let workflowResumed = false;
    if (done.runId && done.stepId) {
      try {
        const runRes = await app.db.query(
          "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
          [device.tenantId, done.runId],
        );
        const runStatus = runRes.rowCount ? String((runRes.rows[0] as any).status ?? "") : "";
        if (runStatus === "needs_device") {
          const jobRes = await app.db.query(
            "SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
            [device.tenantId, done.runId],
          );
          const jobId = jobRes.rowCount ? String((jobRes.rows[0] as any).job_id ?? "") : "";
          if (jobId) {
            await app.db.query(
              "UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status = 'needs_device'",
              [device.tenantId, done.runId],
            );
            await app.db.query(
              "UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2",
              [device.tenantId, jobId],
            );
            await app.db.query(
              "UPDATE steps SET status = 'pending', queue_job_id = NULL, updated_at = now() WHERE step_id = $1 AND status = 'pending'",
              [done.stepId],
            );
            const bj = await app.queue.add(
              "step",
              { jobId, runId: done.runId, stepId: done.stepId },
              { attempts: 3, backoff: { type: "exponential", delay: 500 } },
            );
            await app.db.query(
              "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2 AND (queue_job_id IS NULL OR queue_job_id = '')",
              [String((bj as any).id), done.stepId],
            );
            workflowResumed = true;
            console.log(`[device-result] workflow resumed: runId=${done.runId} stepId=${done.stepId} deviceExecutionId=${done.deviceExecutionId} jobId=${jobId}`);
          }
        }
      } catch (resumeErr) {
        // 恢复失败不影响 result 返回，Worker ticker 会兜底
        console.error(`[device-result] workflow resume failed: runId=${done.runId} stepId=${done.stepId}`, resumeErr);
      }
    }

    req.ctx.audit!.outputDigest = { deviceExecutionId: done.deviceExecutionId, status: done.status, outputDigest: digestObject(body.outputDigest ?? null), evidenceCount: body.evidenceRefs?.length ?? 0, errorCategory: body.errorCategory ?? null, workflowResumed };
    return { execution: done, workflowResumed };
  });
};
