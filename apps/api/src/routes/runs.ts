import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { requirePermission } from "../modules/auth/guard";
import { getToolDefinition } from "../modules/tools/toolRepo";
import { getToolVersionByRef } from "../modules/tools/toolRepo";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { getEffectiveToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { createApproval } from "../modules/workflow/approvalRepo";
import { decryptSecretPayload } from "../modules/secrets/envelope";
import {
  cancelDeadletterStep,
  cancelRun,
  createJobRunStep,
  getRunForSpace,
  listDeadletterStepsByTenant,
  listRuns,
  listSteps,
  retryDeadletterStep,
} from "../modules/workflow/jobRepo";
import { buildRunReplay } from "../modules/workflow/replayRepo";

export const runRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/workflow/deadletters", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "workflow.deadletter.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.deadletter.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        toolRef: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const deadletters = await listDeadletterStepsByTenant({
      pool: app.db,
      tenantId: subject.tenantId,
      toolRef: q.toolRef,
      limit: q.limit ?? 50,
    });
    req.ctx.audit!.outputDigest = { count: deadletters.length };
    return { deadletters };
  });

  app.get("/governance/workflow/steps/:stepId/output/reveal", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.step.output.reveal" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.step.output.reveal" });
    req.ctx.audit!.policyDecision = decision;
    req.ctx.audit!.inputDigest = { stepId: params.stepId };

    const res = await app.db.query(
      `
        SELECT
          s.step_id,
          s.run_id,
          s.seq,
          s.tool_ref,
          s.input,
          s.output_enc_format,
          s.output_key_version,
          s.output_encrypted_payload,
          r.tenant_id
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE s.step_id = $1
        LIMIT 1
      `,
      [params.stepId],
    );
    if (!res.rowCount) throw Errors.badRequest("Step 不存在");
    const row = res.rows[0] as any;
    if (String(row.tenant_id ?? "") !== subject.tenantId) throw Errors.badRequest("Step 不存在");

    const encFormat = (row.output_enc_format as string | null) ?? null;
    const keyVersion = (row.output_key_version as number | null) ?? null;
    const encryptedPayload = row.output_encrypted_payload ?? null;
    if (encFormat === "envelope.v1" && (!encryptedPayload || !keyVersion)) throw Errors.stepPayloadExpired();
    if (!encFormat || !keyVersion || !encryptedPayload || encFormat !== "envelope.v1") throw Errors.stepOutputNotEncrypted();

    const metaInput = row.input as any;
    const spaceId =
      (metaInput?.spaceId as string | undefined) ??
      (metaInput?.space_id as string | undefined) ??
      (encryptedPayload?.keyRef?.scopeId as string | undefined) ??
      null;
    if (!spaceId) throw Errors.stepOutputNotEncrypted();
    if (subject.spaceId && String(subject.spaceId) !== String(spaceId)) throw Errors.forbidden();

    const output = await decryptSecretPayload({
      pool: app.db,
      tenantId: subject.tenantId,
      masterKey: app.cfg.secrets.masterKey,
      scopeType: "space",
      scopeId: String(spaceId),
      keyVersion: Number(keyVersion),
      encFormat,
      encryptedPayload,
    });
    req.ctx.audit!.outputDigest = { status: "revealed", runId: String(row.run_id), stepId: String(row.step_id) };
    return { output };
  });

  app.post("/governance/workflow/steps/:stepId/compensate", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.step.compensate" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.step.compensate" });
    req.ctx.audit!.policyDecision = decision;
    req.ctx.audit!.inputDigest = { stepId: params.stepId };

    const res = await app.db.query(
      `
        SELECT
          s.step_id,
          s.run_id,
          s.seq,
          s.tool_ref,
          s.input,
          s.compensation_enc_format,
          s.compensation_key_version,
          s.compensation_encrypted_payload,
          r.tenant_id
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE s.step_id = $1
        LIMIT 1
      `,
      [params.stepId],
    );
    if (!res.rowCount) throw Errors.badRequest("Step 不存在");
    const row = res.rows[0] as any;
    if (String(row.tenant_id ?? "") !== subject.tenantId) throw Errors.badRequest("Step 不存在");

    const encFormat = (row.compensation_enc_format as string | null) ?? null;
    const keyVersion = (row.compensation_key_version as number | null) ?? null;
    const encryptedPayload = row.compensation_encrypted_payload ?? null;
    if (!encFormat || encFormat !== "envelope.v1" || !keyVersion || !encryptedPayload) throw Errors.stepNotCompensable();

    const metaInput = row.input as any;
    const spaceId =
      (metaInput?.spaceId as string | undefined) ??
      (metaInput?.space_id as string | undefined) ??
      (encryptedPayload?.keyRef?.scopeId as string | undefined) ??
      null;
    if (!spaceId) throw Errors.stepNotCompensable();
    if (subject.spaceId && String(subject.spaceId) !== String(spaceId)) throw Errors.forbidden();

    const payload = await decryptSecretPayload({
      pool: app.db,
      tenantId: subject.tenantId,
      masterKey: app.cfg.secrets.masterKey,
      scopeType: "space",
      scopeId: String(spaceId),
      keyVersion: Number(keyVersion),
      encFormat,
      encryptedPayload,
    });
    const compensateToolRef = String(payload?.compensatingToolRef ?? "");
    const compensateInput = payload?.input ?? null;
    if (!compensateToolRef || !compensateInput) throw Errors.stepNotCompensable();

    const at = compensateToolRef.lastIndexOf("@");
    const toolName = at > 0 ? compensateToolRef.slice(0, at) : "";
    if (!toolName) throw Errors.stepNotCompensable();
    const ver = await getToolVersionByRef(app.db, subject.tenantId, compensateToolRef);
    if (!ver || String(ver.status) !== "released") throw Errors.stepNotCompensable();
    const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId!, toolRef: compensateToolRef });
    if (!enabled) throw Errors.toolDisabled();
    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = def?.scope ?? null;
    const resourceType = def?.resourceType ?? null;
    const action = def?.action ?? null;
    if (!scope || !resourceType || !action) throw Errors.stepNotCompensable();
    if (scope !== "write") throw Errors.stepNotCompensable();
    const opDecision = await requirePermission({ req, resourceType, action });
    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef: compensateToolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
    const env: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: { tenantId: subject.tenantId, spaceId: String(spaceId), subjectId: subject.subjectId ?? null, toolContract: { scope, resourceType, action, fieldRules: (opDecision as any).fieldRules ?? null, rowFilters: (opDecision as any).rowFilters ?? null } },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
      resourceDomain: { limits: normalizeRuntimeLimitsV1({}) },
    };

    const idem = `idem-comp-${params.stepId}`;
    const created = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "tool.execute",
      toolRef: compensateToolRef,
      policySnapshotRef: opDecision.snapshotRef,
      idempotencyKey: idem,
      input: {
        toolRef: compensateToolRef,
        traceId: req.ctx.traceId,
        spaceId: String(spaceId),
        subjectId: subject.subjectId,
        toolContract: {
          scope,
          resourceType,
          action,
          idempotencyRequired: def?.idempotencyRequired,
          riskLevel: def?.riskLevel,
          approvalRequired: def?.approvalRequired,
          fieldRules: env.dataDomain.toolContract.fieldRules ?? null,
          rowFilters: env.dataDomain.toolContract.rowFilters ?? null,
        },
        input: compensateInput,
        limits: env.resourceDomain.limits,
        networkPolicy: env.egressDomain.networkPolicy,
        capabilityEnvelope: env,
      },
      createdBySubjectId: subject.subjectId,
      trigger: "compensate",
      masterKey: app.cfg.secrets.masterKey,
    });

    const ex = await app.db.query(
      "SELECT compensation_id FROM workflow_step_compensations WHERE tenant_id = $1 AND step_id = $2 AND compensation_run_id = $3 LIMIT 1",
      [subject.tenantId, params.stepId, created.run.runId],
    );
    if (!ex.rowCount) {
      await app.db.query(
        `
          INSERT INTO workflow_step_compensations (tenant_id, step_id, compensation_job_id, compensation_run_id, status, created_by_subject_id)
          VALUES ($1,$2,$3,$4,'queued',$5)
        `,
        [subject.tenantId, params.stepId, created.job.jobId, created.run.runId, subject.subjectId],
      );
    }

    const bj = await app.queue.add(
      "step",
      { jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
    );
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), created.step.stepId]);

    req.ctx.audit!.outputDigest = { compensation: { jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId, toolRef: compensateToolRef } };
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "governance",
      action: "workflow.step.compensate",
      policyDecision: decision,
      inputDigest: { stepId: params.stepId },
      outputDigest: { jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId, toolRef: compensateToolRef },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: String(row.run_id),
      stepId: params.stepId,
    });

    return { receipt: { jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId, status: created.job.status } };
  });

  app.get("/governance/workflow/steps/:stepId/compensations", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.step.compensate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "workflow.step.compensate" });

    const res = await app.db.query(
      `
        SELECT c.*, r.status AS compensation_run_status
        FROM workflow_step_compensations c
        JOIN runs r ON r.run_id = c.compensation_run_id
        JOIN steps s ON s.step_id = c.step_id
        JOIN runs rr ON rr.run_id = s.run_id
        WHERE c.tenant_id = $1 AND c.step_id = $2
        ORDER BY c.created_at DESC
        LIMIT 50
      `,
      [subject.tenantId, params.stepId],
    );
    const items = (res.rows as any[]).map((r) => ({
      compensationId: r.compensation_id,
      stepId: r.step_id,
      compensationJobId: r.compensation_job_id,
      compensationRunId: r.compensation_run_id,
      status: r.status,
      runStatus: r.compensation_run_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    req.ctx.audit!.outputDigest = { stepId: params.stepId, count: items.length };
    return { items };
  });

  app.post("/governance/workflow/compensations/:compensationId/retry", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ compensationId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.step.compensation.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.step.compensation.retry" });
    req.ctx.audit!.policyDecision = decision;
    req.ctx.audit!.inputDigest = { compensationId: params.compensationId };

    const res = await app.db.query(
      `
        SELECT
          c.compensation_id,
          c.step_id,
          c.compensation_job_id,
          c.compensation_run_id,
          c.status AS compensation_status,
          r.status AS run_status,
          (s.input->>'spaceId') AS space_id
        FROM workflow_step_compensations c
        JOIN runs r ON r.run_id = c.compensation_run_id
        JOIN steps s ON s.step_id = c.step_id
        WHERE c.tenant_id = $1 AND c.compensation_id = $2
        LIMIT 1
      `,
      [subject.tenantId, params.compensationId],
    );
    if (!res.rowCount) throw Errors.badRequest("Compensation 不存在");
    const row = res.rows[0] as any;
    const spaceId = String(row.space_id ?? "");
    if (!spaceId) throw Errors.badRequest("缺少 spaceId");
    if (subject.spaceId && String(subject.spaceId) !== spaceId) throw Errors.forbidden();
    if (String(row.run_status ?? "") !== "failed") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Compensation Run 不在 failed 状态");
    }

    const runId = String(row.compensation_run_id);
    const jobId = String(row.compensation_job_id);
    const stepRes = await app.db.query("SELECT step_id FROM steps WHERE run_id = $1 AND seq = 1 LIMIT 1", [runId]);
    if (!stepRes.rowCount) throw Errors.badRequest("Step 不存在");
    const stepId = String(stepRes.rows[0].step_id);

    await app.db.query("UPDATE runs SET status = 'queued', updated_at = now(), finished_at = NULL WHERE tenant_id = $1 AND run_id = $2", [
      subject.tenantId,
      runId,
    ]);
    await app.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, jobId]);
    await app.db.query(
      "UPDATE steps SET status = 'pending', updated_at = now(), finished_at = NULL, deadlettered_at = NULL, queue_job_id = NULL WHERE run_id = $1 AND status IN ('failed','timeout','canceled','deadletter')",
      [runId],
    );
    await app.db.query("UPDATE workflow_step_compensations SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND compensation_id = $2", [
      subject.tenantId,
      params.compensationId,
    ]);

    const bj = await app.queue.add("step", { jobId, runId, stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), stepId]);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "governance",
      action: "workflow.step.compensation.retry",
      policyDecision: decision,
      inputDigest: { compensationId: params.compensationId, runId, stepId },
      outputDigest: { jobId, status: "queued" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId,
      stepId,
    });
    req.ctx.audit!.outputDigest = { compensationId: params.compensationId, runId, stepId, status: "queued" };
    return { receipt: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId, stepId }, status: "queued" as const } };
  });

  app.post("/governance/workflow/compensations/:compensationId/cancel", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ compensationId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.step.compensation.cancel" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.step.compensation.cancel" });
    req.ctx.audit!.policyDecision = decision;
    req.ctx.audit!.inputDigest = { compensationId: params.compensationId };

    const res = await app.db.query(
      `
        SELECT
          c.compensation_id,
          c.step_id,
          c.compensation_job_id,
          c.compensation_run_id,
          r.status AS run_status,
          (s.input->>'spaceId') AS space_id
        FROM workflow_step_compensations c
        JOIN runs r ON r.run_id = c.compensation_run_id
        JOIN steps s ON s.step_id = c.step_id
        WHERE c.tenant_id = $1 AND c.compensation_id = $2
        LIMIT 1
      `,
      [subject.tenantId, params.compensationId],
    );
    if (!res.rowCount) throw Errors.badRequest("Compensation 不存在");
    const row = res.rows[0] as any;
    const spaceId = String(row.space_id ?? "");
    if (!spaceId) throw Errors.badRequest("缺少 spaceId");
    if (subject.spaceId && String(subject.spaceId) !== spaceId) throw Errors.forbidden();

    const runStatus = String(row.run_status ?? "");
    if (["succeeded", "failed", "canceled", "compensated"].includes(runStatus)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.runNotCancelable();
    }

    const runId = String(row.compensation_run_id);
    const run = await cancelRun({ pool: app.db, tenantId: subject.tenantId, runId });
    if (!run) throw Errors.badRequest("Run 不存在");
    await app.db.query("UPDATE workflow_step_compensations SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND compensation_id = $2", [
      subject.tenantId,
      params.compensationId,
    ]);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "governance",
      action: "workflow.step.compensation.cancel",
      policyDecision: decision,
      inputDigest: { compensationId: params.compensationId, runId },
      outputDigest: { runId: run.runId, status: run.status },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
    });
    req.ctx.audit!.outputDigest = { compensationId: params.compensationId, runId: run.runId, status: run.status };
    return { run };
  });

  app.post("/governance/workflow/deadletters/:stepId/retry", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.deadletter.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.deadletter.retry" });
    req.ctx.audit!.policyDecision = decision;

    const step = await retryDeadletterStep({ pool: app.db, tenantId: subject.tenantId, stepId: params.stepId });
    if (!step) throw Errors.badRequest("Step 不存在或不在 deadletter 状态");

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [
      subject.tenantId,
      step.runId,
    ]);
    if (!jobRes.rowCount) throw Errors.badRequest("Job 不存在");
    const jobId = jobRes.rows[0].job_id as string;

    const bj = await app.queue.add("step", { jobId, runId: step.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String(bj.id), step.stepId]);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "governance",
      action: "workflow:deadletter_retry",
      policyDecision: decision,
      inputDigest: { runId: step.runId, stepId: step.stepId },
      outputDigest: { jobId, status: "queued" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: step.runId,
      stepId: step.stepId,
    });
    req.ctx.audit!.outputDigest = { runId: step.runId, stepId: step.stepId, status: "queued" };
    return { receipt: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: step.runId, stepId: step.stepId }, status: "queued" as const } };
  });

  app.post("/governance/workflow/deadletters/:stepId/cancel", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "workflow.deadletter.cancel" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.deadletter.cancel" });
    req.ctx.audit!.policyDecision = decision;

    const step = await cancelDeadletterStep({ pool: app.db, tenantId: subject.tenantId, stepId: params.stepId });
    if (!step) throw Errors.badRequest("Step 不存在或不在 deadletter 状态");

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "governance",
      action: "workflow:deadletter_cancel",
      policyDecision: decision,
      inputDigest: { runId: step.runId, stepId: step.stepId },
      outputDigest: { status: "canceled" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: step.runId,
      stepId: step.stepId,
    });
    req.ctx.audit!.outputDigest = { runId: step.runId, stepId: step.stepId, status: "canceled" };
    return { receipt: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: step.runId, stepId: step.stepId }, status: "canceled" as const } };
  });

  app.get("/runs", async (req) => {
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        status: z.string().optional(),
        updatedFrom: z.string().optional(),
        updatedTo: z.string().optional(),
      })
      .parse(req.query);
    if (q.updatedFrom && Number.isNaN(new Date(q.updatedFrom).getTime())) throw Errors.badRequest("updatedFrom 非法");
    if (q.updatedTo && Number.isNaN(new Date(q.updatedTo).getTime())) throw Errors.badRequest("updatedTo 非法");
    const runs = await listRuns(app.db, subject.tenantId, {
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
      status: q.status,
      spaceId: subject.spaceId,
      updatedFrom: q.updatedFrom,
      updatedTo: q.updatedTo,
    });
    return { runs };
  });

  app.get("/runs/:runId", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const steps = await listSteps(app.db, run.runId);
    return { run, steps };
  });

  app.get("/runs/:runId/replay", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "run.replay" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const visible = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!visible) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const replay = await buildRunReplay({ pool: app.db, tenantId: subject.tenantId, runId: params.runId, limit: 500 });
    if (!replay) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    req.ctx.audit!.outputDigest = { replayedRunId: replay.run.runId, stepCount: replay.steps.length, timelineCount: replay.timeline.length };
    return replay;
  });

  app.post("/runs/:runId/cancel", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "cancel" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "cancel" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const existing = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!existing) throw Errors.badRequest("Run 不存在");
    if (["succeeded", "failed", "canceled", "compensated"].includes(existing.status)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.runNotCancelable();
    }
    const run = await cancelRun({ pool: app.db, tenantId: subject.tenantId, runId: params.runId });
    if (!run) throw Errors.badRequest("Run 不存在");
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.canceled",
      policyDecision: decision,
      outputDigest: { runId: run.runId, status: run.status },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
    });
    req.ctx.audit!.outputDigest = { runId: run.runId, status: run.status };
    return { run };
  });

  app.post("/runs/:runId/retry", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "retry" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "retry" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");
    if (run.status !== "failed") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Run 不在 failed 状态");
    }

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [
      subject.tenantId,
      run.runId,
    ]);
    if (!jobRes.rowCount) throw Errors.badRequest("Job 不存在");
    const jobId = jobRes.rows[0].job_id as string;
    const stepRes = await app.db.query("SELECT step_id FROM steps WHERE run_id = $1 AND seq = 1 LIMIT 1", [run.runId]);
    if (!stepRes.rowCount) throw Errors.badRequest("Step 不存在");
    const stepId = stepRes.rows[0].step_id as string;

    await app.db.query("UPDATE runs SET status = 'queued', updated_at = now(), finished_at = NULL WHERE tenant_id = $1 AND run_id = $2", [
      subject.tenantId,
      run.runId,
    ]);
    await app.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, jobId]);
    await app.db.query(
      "UPDATE steps SET status = 'pending', updated_at = now(), finished_at = NULL, deadlettered_at = NULL, queue_job_id = NULL WHERE run_id = $1 AND status IN ('failed','timeout','canceled','deadletter')",
      [run.runId],
    );

    await app.queue.add("step", { jobId, runId: run.runId, stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.retry",
      policyDecision: decision,
      inputDigest: { runId: run.runId, stepId },
      outputDigest: { jobId, status: "queued" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
      stepId,
    });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = receipt;
    return { receipt };
  });

  app.post("/runs/:runId/reexec", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "run.reexec" });

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const visible = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!visible) throw Errors.badRequest("Run 不存在");

    const s0 = await app.db.query(
      `
        SELECT s.input, s.tool_ref
        FROM steps s
        WHERE s.run_id = $1 AND s.seq = 1
        LIMIT 1
      `,
      [visible.runId],
    );
    if (!s0.rowCount) throw Errors.badRequest("Step 不存在");
    let stepInput = s0.rows[0].input as any;
    const enc = await app.db.query(
      "SELECT input_enc_format, input_key_version, input_encrypted_payload FROM steps WHERE run_id = $1 AND seq = 1 LIMIT 1",
      [visible.runId],
    );
    if (enc.rowCount) {
      const encFormat = enc.rows[0].input_enc_format as string | null;
      const keyVersion = enc.rows[0].input_key_version as number | null;
      const encryptedPayload = enc.rows[0].input_encrypted_payload as any;
      const spaceId = stepInput?.spaceId ?? null;
      if (encFormat && keyVersion && encryptedPayload && spaceId) {
        stepInput = await decryptSecretPayload({
          pool: app.db,
          tenantId: subject.tenantId,
          masterKey: app.cfg.secrets.masterKey,
          scopeType: "space",
          scopeId: String(spaceId),
          keyVersion: Number(keyVersion),
          encFormat,
          encryptedPayload,
        });
      }
    }
    const toolRef = (s0.rows[0].tool_ref as string | null) ?? (stepInput?.toolRef as string | undefined) ?? null;
    if (!toolRef) throw Errors.badRequest("缺少 toolRef");

    const toolName = toolRef.split("@")[0] ?? "";
    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = stepInput?.toolContract?.scope ?? def?.scope ?? null;
    const resourceType = stepInput?.toolContract?.resourceType ?? def?.resourceType ?? null;
    const action = stepInput?.toolContract?.action ?? def?.action ?? null;
    const idempotencyRequired = stepInput?.toolContract?.idempotencyRequired ?? def?.idempotencyRequired ?? null;
    if (!scope || !resourceType || !action || idempotencyRequired === null) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("工具契约缺失");
    }

    const decision = await requirePermission({ req, resourceType, action });
    req.ctx.audit!.policyDecision = decision;

    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };

    const cap = stepInput?.capabilityEnvelope ?? null;
    if (!cap) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "missing" } };
      throw Errors.badRequest("缺少 capabilityEnvelope");
    }
    const parsed = validateCapabilityEnvelopeV1(cap);
    if (!parsed.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "invalid" } };
      throw Errors.badRequest("capabilityEnvelope 不合法");
    }
    const effLimits = normalizeRuntimeLimitsV1(stepInput?.limits);
    const effectiveEnvelope: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: {
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        subjectId: subject.subjectId ?? null,
        toolContract: { scope, resourceType, action, fieldRules: (decision as any).fieldRules ?? null, rowFilters: (decision as any).rowFilters ?? null },
      },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
      resourceDomain: { limits: effLimits },
    };
    const subset = checkCapabilityEnvelopeNotExceedV1({ envelope: parsed.envelope, effective: effectiveEnvelope });
    if (!subset.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "not_subset", reason: subset.reason } };
      throw Errors.badRequest("capabilityEnvelope 不得扩大权限");
    }
    const finalEnvelope = parsed.envelope;
    stepInput = {
      ...stepInput,
      toolContract: { ...(stepInput?.toolContract ?? {}), fieldRules: finalEnvelope.dataDomain.toolContract.fieldRules ?? null, rowFilters: finalEnvelope.dataDomain.toolContract.rowFilters ?? null },
      limits: finalEnvelope.resourceDomain.limits,
      networkPolicy: finalEnvelope.egressDomain.networkPolicy,
      capabilityEnvelope: finalEnvelope,
    };

    const newIdempotencyKey = uuidv4();
    const { job, run, step } = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "tool.execute",
      toolRef,
      policySnapshotRef: decision.snapshotRef,
      idempotencyKey: newIdempotencyKey,
      createdBySubjectId: subject.subjectId,
      trigger: "reexec",
      masterKey: app.cfg.secrets.masterKey,
      input: { ...stepInput, traceId: req.ctx.traceId },
    });
    await app.db.query("UPDATE runs SET reexec_of_run_id = $1, updated_at = now() WHERE tenant_id = $2 AND run_id = $3", [
      visible.runId,
      subject.tenantId,
      run.runId,
    ]);

    const approvalRequired =
      Boolean(stepInput?.toolContract?.approvalRequired) ||
      stepInput?.toolContract?.riskLevel === "high" ||
      Boolean(def?.approvalRequired) ||
      def?.riskLevel === "high";
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };

    if (approvalRequired) {
      await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
      await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        runId: run.runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef,
        policySnapshotRef: decision.snapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
      });
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "workflow",
        action: "workflow:reexec",
        policyDecision: decision,
        inputDigest: { fromRunId: visible.runId, toRunId: run.runId, toolRef },
        outputDigest: { status: "needs_approval", approvalId: approval.approvalId },
        idempotencyKey: newIdempotencyKey,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        runId: run.runId,
        stepId: step.stepId,
      });
      req.ctx.audit!.outputDigest = { fromRunId: visible.runId, toRunId: run.runId, status: "needs_approval", approvalId: approval.approvalId };
      return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, approvalId: approval.approvalId, receipt: { ...receipt, status: "needs_approval" as const } };
    }

    const bj = await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String(bj.id), step.stepId]);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "workflow:reexec",
      policyDecision: decision,
      inputDigest: { fromRunId: visible.runId, toRunId: run.runId, toolRef },
      outputDigest: { status: "queued" },
      idempotencyKey: newIdempotencyKey,
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
      stepId: step.stepId,
    });
    req.ctx.audit!.outputDigest = { fromRunId: visible.runId, toRunId: run.runId, status: "queued" };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, receipt };
  });

  app.post("/runs/:runId/approve", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "approve" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "approve" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");
    if (run.status !== "needs_approval") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Run 不在 needs_approval 状态");
    }

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, run.runId]);
    if (!jobRes.rowCount) throw Errors.badRequest("Job 不存在");
    const jobId = jobRes.rows[0].job_id as string;
    const stepFromApproval = await app.db.query("SELECT step_id FROM approvals WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, run.runId]);
    const stepId0 = stepFromApproval.rowCount ? (stepFromApproval.rows[0].step_id as string | null) : null;
    const stepRes = await app.db.query(
      "SELECT step_id FROM steps WHERE run_id = $1 AND status = 'pending' ORDER BY seq ASC LIMIT 1",
      [run.runId],
    );
    const stepId = stepId0 ?? (stepRes.rowCount ? (stepRes.rows[0].step_id as string) : null);
    if (!stepId) throw Errors.badRequest("Step 不存在");

    const stepInputRes = await app.db.query("SELECT input FROM steps WHERE step_id = $1 LIMIT 1", [stepId]);
    const stepInput = stepInputRes.rowCount ? (stepInputRes.rows[0].input as any) : null;
    if (stepInput?.toolContract?.scope === "write" && !stepInput?.idempotencyKey) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("缺少 idempotency-key");
    }

    await app.db.query("UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
    await app.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, jobId]);

    const bj = await app.queue.add("step", { jobId, runId: run.runId, stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String(bj.id), stepId]);
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.enqueued",
      policyDecision: decision,
      inputDigest: { runId: run.runId, stepId },
      outputDigest: { jobId, status: "queued" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
      stepId,
    });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = receipt;
    return { receipt };
  });

  app.post("/runs/:runId/reject", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "reject" });
    const decision = await requirePermission({ req, resourceType: "workflow", action: "reject" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");
    if (run.status !== "needs_approval") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Run 不在 needs_approval 状态");
    }

    await app.db.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE tenant_id = $1 AND run_id = $2", [
      subject.tenantId,
      run.runId,
    ]);
    await app.db.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status IN ('pending','running')", [
      run.runId,
    ]);
    await app.db.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.rejected",
      policyDecision: decision,
      outputDigest: { runId: run.runId, status: "canceled" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
    });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId }, status: "canceled" as const };
    req.ctx.audit!.outputDigest = receipt;
    return { receipt };
  });
};
