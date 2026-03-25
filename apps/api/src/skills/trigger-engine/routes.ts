import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1 } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { isToolEnabled } from "../../modules/governance/toolGovernanceRepo";
import { getEffectiveToolNetworkPolicy } from "../../modules/governance/toolNetworkPolicyRepo";
import { getToolDefinition, getToolVersionByRef } from "../../modules/tools/toolRepo";
import { createJobRunStep, createJobRunStepWithoutToolRef } from "../../modules/workflow/jobRepo";
import { createTrigger, getTrigger, listTriggerRuns, listTriggers, updateTrigger, computeCronNextFireAt } from "./modules/triggerRepo";

function normalizeTriggerType(v: string) {
  if (v === "cron" || v === "event") return v;
  throw Errors.badRequest("type 非法");
}

export const triggerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/triggers", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "read" });
    const subject = requireSubject(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    const items = await listTriggers({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/governance/triggers", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "manage" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "manage" });
    const subject = requireSubject(req);

    const body = z
      .object({
        spaceId: z.string().min(1).optional(),
        type: z.enum(["cron", "event"]),
        status: z.enum(["enabled", "disabled"]).optional(),
        cron: z.object({ expr: z.string().min(1), tz: z.string().min(1).optional(), misfirePolicy: z.enum(["skip", "catchup"]).optional() }).optional(),
        event: z.object({ source: z.enum(["ingress.envelope", "governance.audit"]), filter: z.any().optional() }).optional(),
        target: z.object({ kind: z.enum(["workflow", "job"]), ref: z.string().min(1) }),
        inputMapping: z.any().optional(),
        idempotency: z.object({ keyTemplate: z.string().min(1).max(300).optional(), windowSec: z.number().int().positive().max(86400).optional() }).optional(),
        rateLimitPerMin: z.number().int().positive().max(3000).optional(),
      })
      .parse(req.body);

    if (body.type === "cron" && !body.cron) throw Errors.badRequest("缺少 cron 配置");
    if (body.type === "event" && !body.event) throw Errors.badRequest("缺少 event 配置");

    const enabledLimit = Number(process.env.TRIGGER_MAX_ENABLED ?? 200);
    if ((body.status ?? "enabled") === "enabled") {
      const enabledCount = await app.db.query("SELECT count(*)::int AS c FROM trigger_definitions WHERE tenant_id = $1 AND status = 'enabled'", [subject.tenantId]);
      const c = Number(enabledCount.rows[0]?.c ?? 0);
      if (c >= enabledLimit) throw Errors.forbidden();
    }

    const trigger = await createTrigger({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: body.spaceId ?? null,
      type: normalizeTriggerType(body.type),
      status: body.status ?? "enabled",
      cronExpr: body.type === "cron" ? (body.cron?.expr ?? null) : null,
      cronTz: body.type === "cron" ? (body.cron?.tz ?? "UTC") : null,
      cronMisfirePolicy: body.type === "cron" ? (body.cron?.misfirePolicy ?? "skip") : "skip",
      eventSource: body.type === "event" ? body.event?.source ?? null : null,
      eventFilter: body.type === "event" ? body.event?.filter ?? null : null,
      targetKind: body.target.kind,
      targetRef: body.target.ref,
      inputMapping: body.inputMapping ?? null,
      idempotencyKeyTemplate: body.idempotency?.keyTemplate ?? null,
      idempotencyWindowSec: body.idempotency?.windowSec ?? 3600,
      rateLimitPerMin: body.rateLimitPerMin ?? 60,
      createdBySubjectId: subject.subjectId,
    });

    req.ctx.audit!.outputDigest = { triggerId: trigger.triggerId, type: trigger.type, status: trigger.status, target: { kind: trigger.targetKind, ref: trigger.targetRef } };
    return { trigger };
  });

  app.get("/governance/triggers/:triggerId", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ triggerId: z.string().uuid() }).parse(req.params);
    const trigger = await getTrigger({ pool: app.db, tenantId: subject.tenantId, triggerId: params.triggerId });
    if (!trigger) throw Errors.notFound("trigger");
    req.ctx.audit!.outputDigest = { triggerId: trigger.triggerId, type: trigger.type, status: trigger.status };
    return { trigger };
  });

  app.post("/governance/triggers/:triggerId/update", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "manage" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "manage" });
    const subject = requireSubject(req);
    const params = z.object({ triggerId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        status: z.enum(["enabled", "disabled"]).optional(),
        cron: z.object({ expr: z.string().min(1).optional(), tz: z.string().min(1).optional(), misfirePolicy: z.enum(["skip", "catchup"]).optional() }).optional(),
        event: z.object({ source: z.enum(["ingress.envelope", "governance.audit"]).optional(), filter: z.any().optional() }).optional(),
        target: z.object({ kind: z.enum(["workflow", "job"]).optional(), ref: z.string().min(1).optional() }).optional(),
        inputMapping: z.any().optional(),
        idempotency: z.object({ keyTemplate: z.string().min(1).max(300).optional(), windowSec: z.number().int().positive().max(86400).optional() }).optional(),
        rateLimitPerMin: z.number().int().positive().max(3000).optional(),
      })
      .parse(req.body);

    const updated = await updateTrigger({
      pool: app.db,
      tenantId: subject.tenantId,
      triggerId: params.triggerId,
      patch: {
        status: body.status,
        cronExpr: body.cron?.expr,
        cronTz: body.cron?.tz,
        cronMisfirePolicy: body.cron?.misfirePolicy,
        eventSource: body.event?.source,
        eventFilter: body.event?.filter,
        targetKind: body.target?.kind as any,
        targetRef: body.target?.ref,
        inputMapping: body.inputMapping,
        idempotencyKeyTemplate: body.idempotency?.keyTemplate,
        idempotencyWindowSec: body.idempotency?.windowSec,
        rateLimitPerMin: body.rateLimitPerMin,
      },
    });
    if (!updated) throw Errors.notFound("trigger");
    req.ctx.audit!.outputDigest = { triggerId: updated.triggerId, status: updated.status };
    return { trigger: updated };
  });

  app.get("/governance/triggers/:triggerId/runs", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ triggerId: z.string().uuid() }).parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    const runs = await listTriggerRuns({ pool: app.db, tenantId: subject.tenantId, triggerId: params.triggerId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { triggerId: params.triggerId, count: runs.length };
    return { runs };
  });

  app.post("/governance/triggers/:triggerId/preflight", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "trigger", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ triggerId: z.string().uuid() }).parse(req.params);
    const trigger = await getTrigger({ pool: app.db, tenantId: subject.tenantId, triggerId: params.triggerId });
    if (!trigger) throw Errors.notFound("trigger");
    const enabledCount = await app.db.query("SELECT count(*)::int AS c FROM trigger_definitions WHERE tenant_id = $1 AND status = 'enabled'", [subject.tenantId]);
    const c = Number(enabledCount.rows[0]?.c ?? 0);
    const enabledLimit = Number(process.env.TRIGGER_MAX_ENABLED ?? 200);
    const nextFireAt = trigger.type === "cron" && trigger.cronExpr ? computeCronNextFireAt({ cronExpr: trigger.cronExpr, tz: trigger.cronTz ?? "UTC" }) : null;
    const recentRuns = await listTriggerRuns({ pool: app.db, tenantId: subject.tenantId, triggerId: trigger.triggerId, limit: 20 });
    req.ctx.audit!.outputDigest = { triggerId: trigger.triggerId, type: trigger.type, enabledCount: c };
    return { ok: true, trigger, summary: { nextFireAt, enabledCount: c, enabledLimit }, recentRuns };
  });

  app.post("/governance/triggers/:triggerId/fire", async (req) => {
    setAuditContext(req, { resourceType: "trigger", action: "fire" });
    const decision = await requirePermission({ req, resourceType: "trigger", action: "fire" });
    req.ctx.audit!.policyDecision = decision;
    const subject = requireSubject(req);
    const params = z.object({ triggerId: z.string().uuid() }).parse(req.params);
    const trigger = await getTrigger({ pool: app.db, tenantId: subject.tenantId, triggerId: params.triggerId });
    if (!trigger) throw Errors.notFound("trigger");
    const body = z.object({ scheduledAt: z.string().optional(), event: z.any().optional() }).parse(req.body ?? {});
    const scheduledAt = body.scheduledAt ?? new Date().toISOString();

    const idempotencyKey = trigger.idempotencyKeyTemplate ? `${trigger.idempotencyKeyTemplate}:${scheduledAt}` : null;
    const runIns = await app.db.query(
      `
        INSERT INTO trigger_runs (tenant_id, trigger_id, status, scheduled_at, fired_at, matched, match_reason, match_digest, idempotency_key, event_ref_json)
        VALUES ($1,$2,'queued',$3,now(),true,'manual',$4::jsonb,$5,$6::jsonb)
        RETURNING *
      `,
      [subject.tenantId, trigger.triggerId, scheduledAt, { type: "manual" }, idempotencyKey, body.event ? { source: "manual", event: body.event } : null],
    );
    const triggerRunId = String(runIns.rows[0].trigger_run_id);

    const input = body.event ? body.event : trigger.inputMapping ?? { triggerId: trigger.triggerId, scheduledAt };
    const spaceId = (trigger as any)?.spaceId ?? subject.spaceId ?? null;
    const created =
      trigger.targetKind === "workflow"
        ? await (async () => {
            const toolRef = String(trigger.targetRef ?? "");
            if (!toolRef) throw Errors.badRequest("targetRef 缺失");
            if (!spaceId) throw Errors.badRequest("缺少 spaceId");
            const toolName = toolRef.split("@")[0] ?? "";
            const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
            if (!ver || String((ver as any).status ?? "") !== "released") {
              req.ctx.audit!.errorCategory = "policy_violation";
              throw Errors.badRequest("工具版本不存在/未发布");
            }
            const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: String(spaceId), toolRef });
            if (!enabled) {
              req.ctx.audit!.errorCategory = "policy_violation";
              throw Errors.toolDisabled();
            }
            const def = await getToolDefinition(app.db, subject.tenantId, toolName);
            const scope = def?.scope ?? null;
            const resourceType = def?.resourceType ?? null;
            const action = def?.action ?? null;
            const idempotencyRequired = def?.idempotencyRequired ?? null;
            if (!scope || !resourceType || !action || idempotencyRequired === null) throw Errors.badRequest("工具契约缺失");
            const opDecision = await requirePermission({ req, resourceType, action });
            const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: String(spaceId), toolRef });
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
            return createJobRunStep({
              pool: app.db,
              tenantId: subject.tenantId,
              jobType: "tool.execute",
              toolRef,
              policySnapshotRef: opDecision.snapshotRef,
              idempotencyKey: idempotencyKey ?? undefined,
              input: {
                toolRef,
                idempotencyKey: idempotencyKey ?? undefined,
                toolContract: { scope, resourceType, action, idempotencyRequired, riskLevel: def?.riskLevel, approvalRequired: def?.approvalRequired, fieldRules: env.dataDomain.toolContract.fieldRules ?? null, rowFilters: env.dataDomain.toolContract.rowFilters ?? null },
                input,
                limits: env.resourceDomain.limits,
                networkPolicy: env.egressDomain.networkPolicy,
                capabilityEnvelope: env,
                tenantId: subject.tenantId,
                spaceId: String(spaceId),
                subjectId: subject.subjectId,
                traceId: req.ctx.traceId,
              },
              createdBySubjectId: subject.subjectId,
              trigger: `trigger:${trigger.triggerId}`,
              masterKey: app.cfg.secrets.masterKey,
            });
          })()
        : await createJobRunStepWithoutToolRef({
            pool: app.db,
            tenantId: subject.tenantId,
            jobType: trigger.targetRef,
            runToolRef: `trigger.job:${trigger.targetRef}`,
            idempotencyKey: idempotencyKey ?? undefined,
            input,
            createdBySubjectId: subject.subjectId,
            trigger: `trigger:${trigger.triggerId}`,
          });

    await app.db.query(
      "UPDATE trigger_runs SET status='succeeded', job_id=$3, run_id=$4, step_id=$5, updated_at=now() WHERE tenant_id=$1 AND trigger_run_id=$2",
      [subject.tenantId, triggerRunId, created.job.jobId, created.run.runId, created.step.stepId],
    );
    await app.queue.add("step", { jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });

    req.ctx.audit!.outputDigest = { triggerId: trigger.triggerId, triggerRunId, jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId };
    return { ok: true, triggerRunId, jobId: created.job.jobId, runId: created.run.runId, stepId: created.step.stepId };
  });
};
