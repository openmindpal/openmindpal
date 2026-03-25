import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex, stableStringify } from "../../lib/digest";
import { computeEvalSummary } from "../../modules/governance/evalLogic";
import { addChangeSetItem, approveChangeSet, createChangeSet, getChangeSet, listChangeSetItems, listChangeSets, preflightChangeSet, promoteChangeSet, releaseChangeSet, rollbackChangeSet, submitChangeSet } from "../../modules/governance/changeSetRepo";
import { createEvalRun, createEvalSuite, getActiveEvalRunForChangeSet, getEvalRun, getEvalSuite, listChangeSetEvalBindings, listEvalRuns, listEvalSuites, replaceChangeSetEvalBindings, setEvalRunFinished, updateEvalSuite } from "../../modules/governance/evalRepo";
import { schemaDefSchema } from "../../modules/metadata/schemaModel";
import { evalReportDigest8FromCases, isHighRiskChangeSet } from "./_shared";

export const governanceChangesetsAndEvalsRoutes: FastifyPluginAsync = async (app) => {
  async function enqueueChangeSetEvalSuites(params: { tenantId: string; changesetId: string; suiteIds: string[]; requestedBySubjectId?: string | null }) {
    const out: any[] = [];
    for (const suiteId of params.suiteIds) {
      const suite = await getEvalSuite({ pool: app.db, tenantId: params.tenantId, id: suiteId });
      if (!suite) {
        out.push({ suiteId, status: "blocked_no_suite" });
        continue;
      }
      const reportDigest8 = evalReportDigest8FromCases(Array.isArray(suite.casesJson) ? suite.casesJson : []);
      const active = await getActiveEvalRunForChangeSet({ pool: app.db, tenantId: params.tenantId, suiteId: suite.id, changesetId: params.changesetId, reportDigest8 });
      if (active) {
        out.push({ suiteId: suite.id, evalRunId: active.id, status: "already_running", reportDigest8 });
        continue;
      }
      const totalCases = Array.isArray(suite.casesJson) ? suite.casesJson.length : 0;
      const created = await createEvalRun({ pool: app.db, tenantId: params.tenantId, suiteId: suite.id, changesetId: params.changesetId, status: "queued", summary: { totalCases, reportDigest8 }, evidenceDigest: { caseCount: totalCases, reportDigest8 } });
      await app.queue.add(
        "governance.eval",
        { kind: "governance.evalrun.execute", tenantId: params.tenantId, changesetId: params.changesetId, suiteId: suite.id, evalRunId: created.id, requestedBySubjectId: params.requestedBySubjectId ?? null },
        { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
      );
      out.push({ suiteId: suite.id, evalRunId: created.id, status: "queued", reportDigest8 });
      app.metrics.incEvalRun({ action: "enqueue" });
    }
    return out;
  }

  app.post("/governance/changesets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.create" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.create" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ title: z.string().min(1), scope: z.enum(["tenant", "space"]).optional(), canaryTargets: z.array(z.string().min(1)).max(50).optional() }).parse(req.body);
    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const cs = await createChangeSet({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, title: body.title, createdBy: subject.subjectId, canaryTargets: body.canaryTargets ?? null });
    req.ctx.audit!.outputDigest = { id: cs.id, scopeType, scopeId, status: cs.status };
    return { changeset: cs };
  });

  app.post("/governance/changesets/:id/evals/bind", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ suiteIds: z.array(z.string().uuid()).max(20) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "changeset.bind_evals" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.update" });
    req.ctx.audit!.policyDecision = decision;

    await replaceChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id, suiteIds: body.suiteIds });
    req.ctx.audit!.outputDigest = { changesetId: params.id, suiteIdsCount: body.suiteIds.length };
    return { changesetId: params.id, suiteIds: body.suiteIds };
  });

  app.get("/governance/changesets/:id/evals", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const suiteIds = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id });
    const suites = await Promise.all(suiteIds.map((id: string) => getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id })));
    return { suiteIds, suites: suites.filter(Boolean) };
  });

  app.post("/governance/changesets/:id/evals/execute", async (req, reply) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "evalrun.enqueue" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.execute" });
    req.ctx.audit!.policyDecision = decision;

    const cs = await getChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!cs) throw Errors.badRequest("changeset 不存在");
    const suiteIds = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id });
    if (!suiteIds.length) return reply.status(200).send({ changesetId: params.id, results: [] });

    const results = await enqueueChangeSetEvalSuites({ tenantId: subject.tenantId, changesetId: params.id, suiteIds, requestedBySubjectId: subject.subjectId });
    req.ctx.audit!.outputDigest = { changesetId: params.id, suiteIdsCount: suiteIds.length, queued: results.filter((r) => r.status === "queued").length };
    return { changesetId: params.id, results };
  });

  app.post("/governance/evals/suites", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ name: z.string().min(1), description: z.string().max(2000).optional(), cases: z.array(z.any()).max(200).optional(), thresholds: z.record(z.string(), z.any()).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await createEvalSuite({ pool: app.db, tenantId: subject.tenantId, name: body.name, description: body.description ?? null, casesJson: body.cases ?? [], thresholds: body.thresholds ?? {} });
    req.ctx.audit!.outputDigest = { suiteId: suite.id, name: suite.name };
    return { suite };
  });

  app.put("/governance/evals/suites/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ description: z.string().max(2000).nullable().optional(), cases: z.array(z.any()).max(200).optional(), thresholds: z.record(z.string(), z.any()).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const suite = await updateEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id, description: body.description, casesJson: body.cases, thresholds: body.thresholds });
      return { suite };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.get("/governance/evals/suites", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ limit: z.coerce.number().int().positive().max(50).optional() }).parse(req.query);
    const suites = await listEvalSuites({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 20 });
    return { suites };
  });

  app.get("/governance/evals/suites/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.read" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");
    return { suite };
  });

  app.post("/governance/evals/suites/:id/cases/from-replay", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ runId: z.string().min(3), stepId: z.string().min(3) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalsuite.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalsuite.write" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");

    const src = await app.db.query(
      `
        SELECT r.run_id, r.policy_snapshot_ref, r.created_at, s.step_id, s.tool_ref, s.input_digest, s.output_digest, s.sealed_at, s.sealed_input_digest, s.sealed_output_digest
        FROM runs r
        JOIN steps s ON s.run_id = r.run_id
        WHERE r.tenant_id = $1 AND r.run_id = $2 AND s.step_id = $3
        LIMIT 1
      `,
      [subject.tenantId, body.runId, body.stepId],
    );
    if (!src.rowCount) throw Errors.badRequest("回放来源不存在");

    const r = src.rows[0] as any;
    const sealModeRaw = String(process.env.WORKFLOW_SEAL_MODE ?? "").trim().toLowerCase();
    const sealMode = sealModeRaw === "deny" ? "deny" : sealModeRaw === "off" || sealModeRaw === "0" || sealModeRaw === "false" || sealModeRaw === "no" ? "off" : "audit_only";
    if (sealMode === "deny" && !r.sealed_at) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.sealNotPresent();
    }
    const isSealedDigest = (v: any) => v && typeof v === "object" && typeof (v as any).len === "number" && typeof (v as any).sha256_8 === "string";
    const fallbackSealedInputDigest = () => {
      const s = stableStringify(r.input_digest ?? null);
      return { len: Buffer.byteLength(s, "utf8"), sha256_8: sha256Hex(s).slice(0, 8) };
    };
    const sealedInputDigest = isSealedDigest(r.sealed_input_digest) ? r.sealed_input_digest : fallbackSealedInputDigest();
    const caseId = sha256Hex(`${String(r.run_id)}:${String(r.step_id)}`).slice(0, 12);
    const nextCase = {
      caseId,
      source: { type: "replay", runId: String(r.run_id), stepId: String(r.step_id), createdAt: String(r.created_at) },
      toolRef: String(r.tool_ref ?? ""),
      policySnapshotRef: String(r.policy_snapshot_ref ?? ""),
      inputDigest: r.input_digest ?? null,
      outputDigest: r.output_digest ?? null,
      sealStatus: r.sealed_at ? "sealed" : "legacy",
      sealedInputDigest,
      sealedOutputDigest: r.sealed_output_digest ?? null,
      evidenceCount: Number(r.output_digest?.evidenceCount ?? 0) || 0,
      evidenceDigest: r.output_digest?.evidenceDigest ?? null,
      retrievalLogId: typeof r.output_digest?.retrievalLogId === "string" ? String(r.output_digest.retrievalLogId) : "",
    };

    const existing = Array.isArray(suite.casesJson) ? suite.casesJson : [];
    const deduped = existing.some((c: any) => String(c?.caseId ?? "") === caseId || (c?.source?.runId === nextCase.source.runId && c?.source?.stepId === nextCase.source.stepId));
    const nextCases = deduped ? existing : [...existing, nextCase].slice(0, 200);

    const updated = await updateEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: suite.id, casesJson: nextCases });
    req.ctx.audit!.outputDigest = { suiteId: suite.id, caseId, totalCases: updated.casesJson.length };
    return { suite: updated, added: !deduped, caseId };
  });

  app.post("/governance/evals/suites/:id/runs", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ changesetId: z.string().uuid().optional(), execute: z.boolean().optional(), status: z.enum(["queued", "running", "succeeded", "failed"]).optional(), summary: z.record(z.string(), z.any()).optional(), evidenceDigest: z.record(z.string(), z.any()).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "evalrun.execute" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.execute" });
    req.ctx.audit!.policyDecision = decision;

    const suite = await getEvalSuite({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!suite) throw Errors.badRequest("suite 不存在");

    const shouldExecute = body.execute === true || (body.execute !== false && body.status === undefined && body.summary === undefined && body.evidenceDigest === undefined);
    if (!shouldExecute) {
      const run = await createEvalRun({
        pool: app.db,
        tenantId: subject.tenantId,
        suiteId: suite.id,
        changesetId: body.changesetId ?? null,
        status: body.status ?? "succeeded",
        summary: body.summary ?? { totalCases: (suite.casesJson ?? []).length, passedCases: (suite.casesJson ?? []).length, passRate: 1, denyRate: 0 },
        evidenceDigest: body.evidenceDigest ?? null,
      });
      req.ctx.audit!.outputDigest = { runId: run.id, suiteId: suite.id, changesetId: run.changesetId, status: run.status, result: String(run.summary?.result ?? "") || null };
      return { run };
    }

    if (body.changesetId) {
      const bound = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: body.changesetId });
      if (!bound.includes(suite.id)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.badRequest("suite 未绑定 changeset");
      }
    }

    const casesJson = Array.isArray(suite.casesJson) ? suite.casesJson : [];
    const reportDigest8 = evalReportDigest8FromCases(casesJson);
    const created = await createEvalRun({ pool: app.db, tenantId: subject.tenantId, suiteId: suite.id, changesetId: body.changesetId ?? null, status: "running", summary: { totalCases: casesJson.length, reportDigest8 }, evidenceDigest: { caseCount: casesJson.length, reportDigest8 } });
    let run = created;
    try {
      const summary = computeEvalSummary({ casesJson, thresholds: suite.thresholds ?? {}, reportDigest8 });
      const sealed = casesJson.filter((c: any) => String(c?.sealStatus ?? "") === "sealed").length;
      const legacy = casesJson.filter((c: any) => String(c?.sealStatus ?? "") === "legacy").length;
      const evidenceDigest = { caseCount: casesJson.length, sealed, legacy, reportDigest8 };
      const updated = await setEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, id: created.id, status: "succeeded", summary, evidenceDigest });
      if (updated) run = updated;
    } catch (e: any) {
      const digest8 = sha256Hex(String(e?.message ?? e)).slice(0, 8);
      const updated = await setEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, id: created.id, status: "failed", summary: { totalCases: casesJson.length, reportDigest8, result: "fail", errorDigest8: digest8 }, evidenceDigest: { caseCount: casesJson.length, reportDigest8, errorDigest8: digest8 } });
      if (updated) run = updated;
    }

    req.ctx.audit!.outputDigest = { runId: run.id, suiteId: suite.id, changesetId: run.changesetId, status: run.status, result: String(run.summary?.result ?? "") || null };
    return { run };
  });

  app.get("/governance/evals/runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "evalrun.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ suiteId: z.string().uuid().optional(), changesetId: z.string().uuid().optional(), limit: z.coerce.number().int().positive().max(50).optional() }).parse(req.query);
    const runs = await listEvalRuns({ pool: app.db, tenantId: subject.tenantId, suiteId: q.suiteId, changesetId: q.changesetId, limit: q.limit ?? 20 });
    return { runs };
  });

  app.get("/governance/evals/runs/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "evalrun.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.read" });
    req.ctx.audit!.policyDecision = decision;

    const run = await getEvalRun({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!run) throw Errors.badRequest("run 不存在");
    return { run };
  });

  app.get("/governance/evals/metrics", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "evalrun.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "evalrun.read" });
    req.ctx.audit!.policyDecision = decision;

    const collabRes = await app.db.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN ('succeeded','failed','stopped','canceled'))::int AS finished,
          COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE status = 'needs_approval')::int AS needs_approval
        FROM collab_runs
        WHERE tenant_id = $1
      `,
      [subject.tenantId],
    );
    const collabRow = collabRes.rowCount ? (collabRes.rows[0] as any) : {};

    const planRes = await app.db.query(
      `
        SELECT
          COUNT(*)::int AS plans,
          AVG(NULLIF((payload_digest->>'stepCount')::int, 0))::float AS avg_step_count
        FROM collab_run_events
        WHERE tenant_id = $1 AND type = 'collab.plan.generated'
      `,
      [subject.tenantId],
    );
    const planRow = planRes.rowCount ? (planRes.rows[0] as any) : {};

    const runRes = await app.db.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'needs_approval')::int AS runs_needs_approval,
          COUNT(*) FILTER (WHERE status IN ('succeeded','failed','canceled'))::int AS runs_finished
        FROM runs
        WHERE tenant_id = $1
      `,
      [subject.tenantId],
    );
    const runRow = runRes.rowCount ? (runRes.rows[0] as any) : {};

    const retryRes = await app.db.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE s.attempt > 1)::int AS retried_steps,
          COUNT(*) FILTER (WHERE s.attempt > 1 AND s.status = 'succeeded')::int AS retried_succeeded_steps
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE r.tenant_id = $1
      `,
      [subject.tenantId],
    );
    const retryRow = retryRes.rowCount ? (retryRes.rows[0] as any) : {};

    const collabTotal = Number(collabRow.total ?? 0);
    const collabFinished = Number(collabRow.finished ?? 0);
    const collabSucceeded = Number(collabRow.succeeded ?? 0);
    const collabNeedsApproval = Number(collabRow.needs_approval ?? 0);
    const collabSuccessRate = collabFinished > 0 ? collabSucceeded / collabFinished : 0;
    const collabApprovalRate = collabTotal > 0 ? collabNeedsApproval / collabTotal : 0;

    const out = {
      timestamp: new Date().toISOString(),
      collab: {
        total: collabTotal,
        finished: collabFinished,
        succeeded: collabSucceeded,
        successRate: collabSuccessRate,
        needsApproval: collabNeedsApproval,
        approvalRate: collabApprovalRate,
        planCount: Number(planRow.plans ?? 0),
        avgPlanSteps: planRow.avg_step_count === null || planRow.avg_step_count === undefined ? null : Number(planRow.avg_step_count),
      },
      workflow: {
        runsFinished: Number(runRow.runs_finished ?? 0),
        runsNeedsApproval: Number(runRow.runs_needs_approval ?? 0),
        retriedSteps: Number(retryRow.retried_steps ?? 0),
        retriedSucceededSteps: Number(retryRow.retried_succeeded_steps ?? 0),
      },
    };

    req.ctx.audit!.outputDigest = { collab: { total: collabTotal, finished: collabFinished, succeeded: collabSucceeded }, workflow: { runsFinished: out.workflow.runsFinished } };
    return out;
  });

  app.get("/governance/changesets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional(), limit: z.coerce.number().int().positive().max(50).optional() }).parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;
    const list = await listChangeSets({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 20 });
    return { changesets: list };
  });

  app.get("/governance/changesets/pipelines", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.pipeline.list" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional(), limit: z.coerce.number().int().positive().max(50).optional(), mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;
    const mode = q.mode ?? "full";
    const list = await listChangeSets({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 20 });
    const pipelines = await Promise.all(
      list.map(async (cs) => {
        const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: cs.id, mode });
        const isHighRisk = cs.riskLevel === "high" || cs.requiredApprovals >= 2;
        const evalRequiredSuiteIds = Array.isArray((out as any)?.evalGate?.requiredSuiteIds) ? ((out as any).evalGate.requiredSuiteIds as any[]) : [];
        const evalSuites = Array.isArray((out as any)?.evalGate?.suites) ? ((out as any).evalGate.suites as any[]) : [];
        const evalAdmissionRequired = Boolean((out as any)?.evalGate?.evalAdmissionRequired);
        const evalRequired = (evalRequiredSuiteIds.length > 0 && isHighRisk) || evalAdmissionRequired;
        const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
        const approvalsOk = out.gate.approvalsCount >= out.gate.requiredApprovals;
        const gates = [
          { gateType: "eval_admission", required: evalRequired, status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass" },
          { gateType: "approval", required: out.gate.requiredApprovals > 0, status: approvalsOk ? "pass" : "fail" },
          { gateType: "risk", required: false, status: cs.riskLevel === "low" ? "pass" : "warn" },
        ];
        return { changesetId: cs.id, mode, gates, warningsCount: out.warnings.length };
      }),
    );
    req.ctx.audit!.outputDigest = { count: pipelines.length, limit: q.limit ?? 20, mode, scope: q.scope ?? "all" };
    return { pipelines };
  });

  app.get("/governance/changesets/:id", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const cs = await getChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!cs) throw Errors.badRequest("changeset 不存在");
    const items = await listChangeSetItems({ pool: app.db, tenantId: subject.tenantId, changesetId: cs.id });
    return { changeset: cs, items };
  });

  app.get("/governance/changesets/:id/pipeline", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    const mode = q.mode ?? "full";
    setAuditContext(req, { resourceType: "governance", action: "changeset.pipeline.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const cs = await getChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!cs) throw Errors.badRequest("changeset 不存在");
    const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: cs.id, mode });

    function computeQuotaGate(preflight: any) {
      const plan: any[] = Array.isArray(preflight?.plan) ? preflight.plan : [];
      const current: any[] = Array.isArray(preflight?.currentStateDigest) ? preflight.currentStateDigest : [];
      const modelLimits = plan.filter((p) => p?.kind === "model_limits.set");
      const toolLimits = plan.filter((p) => p?.kind === "tool_limits.set");
      const modelPrev = new Map<string, number | null>();
      const toolPrev = new Map<string, number | null>();
      for (const c of current) {
        if (c?.kind === "model.quota_limit") {
          const k = `${String(c.scopeType ?? "")}:${String(c.scopeId ?? "")}`;
          const prevRpm = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).modelChatRpm) : null;
          modelPrev.set(k, Number.isFinite(prevRpm as any) ? (prevRpm as any) : null);
        }
        if (c?.kind === "tool.limit") {
          const k = String(c.toolRef ?? "");
          const prevC = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).defaultMaxConcurrency) : null;
          toolPrev.set(k, Number.isFinite(prevC as any) ? (prevC as any) : null);
        }
      }
      let modelIncreases = 0;
      let modelDecreases = 0;
      let toolIncreases = 0;
      let toolDecreases = 0;
      let modelMaxNextRpm = 0;
      let modelMaxPrevRpm = 0;
      let toolMaxNextC = 0;
      let toolMaxPrevC = 0;
      const deltaSummary: any[] = [];
      for (const p of modelLimits) {
        const scopeType = String(p.scopeType ?? "");
        const scopeId = String(p.scopeId ?? "");
        const next = Number(p.modelChatRpm);
        const k = `${scopeType}:${scopeId}`;
        const prev = modelPrev.has(k) ? modelPrev.get(k)! : null;
        if (Number.isFinite(next)) {
          modelMaxNextRpm = Math.max(modelMaxNextRpm, next);
          if (typeof prev === "number" && Number.isFinite(prev)) modelMaxPrevRpm = Math.max(modelMaxPrevRpm, prev);
        }
        if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
          if (next > prev) modelIncreases += 1;
          else if (next < prev) modelDecreases += 1;
        } else if (Number.isFinite(next)) {
          modelIncreases += 1;
        }
        deltaSummary.push({ kind: "model_limits.set", scopeType, scopeId, next: Number.isFinite(next) ? next : null, prev });
      }
      for (const p of toolLimits) {
        const toolRef = String(p.toolRef ?? "");
        const next = Number(p.defaultMaxConcurrency);
        const prev = toolPrev.has(toolRef) ? toolPrev.get(toolRef)! : null;
        if (Number.isFinite(next)) {
          toolMaxNextC = Math.max(toolMaxNextC, next);
          if (typeof prev === "number" && Number.isFinite(prev)) toolMaxPrevC = Math.max(toolMaxPrevC, prev);
        }
        if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
          if (next > prev) toolIncreases += 1;
          else if (next < prev) toolDecreases += 1;
        } else if (Number.isFinite(next)) {
          toolIncreases += 1;
        }
        deltaSummary.push({ kind: "tool_limits.set", toolRef, next: Number.isFinite(next) ? next : null, prev });
      }
      const increaseCount = modelIncreases + toolIncreases;
      const status = increaseCount > 0 ? "warn" : "pass";
      const digest8 = sha256Hex(JSON.stringify(deltaSummary.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).slice(0, 8);
      return { gateType: "quota", required: false, status, detailsDigest: { modelLimitsCount: modelLimits.length, toolLimitsCount: toolLimits.length, modelIncreases, modelDecreases, toolIncreases, toolDecreases, modelMaxNextRpm: modelMaxNextRpm || null, modelMaxPrevRpm: modelMaxPrevRpm || null, toolMaxNextConcurrency: toolMaxNextC || null, toolMaxPrevConcurrency: toolMaxPrevC || null, deltaDigest8: digest8 } };
    }

    function computeGates(params2: { cs: any; preflight: any }) {
      const cs2 = params2.cs;
      const preflight = params2.preflight;
      const isHighRisk = cs2.riskLevel === "high" || cs2.requiredApprovals >= 2;
      const evalRequiredSuiteIds = Array.isArray(preflight?.evalGate?.requiredSuiteIds) ? (preflight.evalGate.requiredSuiteIds as any[]) : [];
      const evalSuites = Array.isArray(preflight?.evalGate?.suites) ? (preflight.evalGate.suites as any[]) : [];
      const evalAdmissionRequired = Boolean(preflight?.evalGate?.evalAdmissionRequired);
      const evalRequired = (evalRequiredSuiteIds.length > 0 && isHighRisk) || evalAdmissionRequired;
      const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
      const approvalsOk = preflight.gate.approvalsCount >= preflight.gate.requiredApprovals;
      const quotaGate = computeQuotaGate(preflight as any);
      const gates = [
        { gateType: "eval_admission", required: evalRequired, status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass", detailsDigest: { requiredSuites: evalRequiredSuiteIds.length, suites: evalSuites.length, failedSuites: evalSuites.filter((e: any) => !e?.passed).length, latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8) } },
        { gateType: "approval", required: preflight.gate.requiredApprovals > 0, status: approvalsOk ? "pass" : "fail", detailsDigest: { requiredApprovals: preflight.gate.requiredApprovals, approvalsCount: preflight.gate.approvalsCount } },
        { gateType: "risk", required: false, status: cs2.riskLevel === "low" ? "pass" : "warn", detailsDigest: { riskLevel: cs2.riskLevel } },
        quotaGate,
      ];
      return { gates };
    }

    const gates = computeGates({ cs, preflight: out }).gates;
    const rollbackPreviewDigest8 = sha256Hex(JSON.stringify(out.rollbackPreview)).slice(0, 8);
    const pipeline = {
      changeset: { id: cs.id, title: cs.title ?? null, status: cs.status, riskLevel: cs.riskLevel, requiredApprovals: cs.requiredApprovals, scopeType: cs.scopeType, scopeId: cs.scopeId, createdAt: cs.createdAt, createdBy: cs.createdBy },
      gates,
      rollout: { mode, canaryTargets: cs.canaryTargets ?? null, canaryReleasedAt: cs.canaryReleasedAt, releasedAt: cs.releasedAt, promotedAt: cs.promotedAt, rolledBackAt: cs.status === "rolled_back" ? cs.updatedAt : null },
      warnings: out.warnings,
      rollbackPreviewDigest: { actionCount: out.rollbackPreview.length, sha256_8: rollbackPreviewDigest8 },
    };
    req.ctx.audit!.outputDigest = { changesetId: cs.id, mode, gateStatuses: gates.map((g: any) => ({ gateType: g.gateType, status: g.status })), warnings: out.warnings.slice(0, 10) };
    app.metrics.incGovernancePipelineAction({ action: "pipeline.read", result: "ok" });
    return { pipeline, preflight: out };
  });

  app.post("/governance/changesets/:id/items", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.update" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .union([
        z.object({ kind: z.literal("tool.enable"), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("tool.disable"), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("tool.set_active"), name: z.string().min(1), toolRef: z.string().min(3) }),
        z.object({ kind: z.literal("ui.page.publish"), pageName: z.string().min(1) }),
        z.object({ kind: z.literal("ui.page.rollback"), pageName: z.string().min(1) }),
        z.object({ kind: z.literal("policy.cache.invalidate"), scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), reason: z.string().min(1).max(500) }),
        z.object({ kind: z.literal("policy.version.release"), name: z.string().min(1).max(200), version: z.number().int().positive() }),
        z.object({ kind: z.literal("policy.publish"), policyId: z.string().uuid(), version: z.number().int().positive() }),
        z.object({ kind: z.literal("policy.set_active"), policyId: z.string().uuid(), version: z.number().int().positive() }),
        z.object({ kind: z.literal("policy.rollback"), policyId: z.string().uuid() }),
        z.object({ kind: z.literal("policy.set_override"), policyId: z.string().uuid(), spaceId: z.string().min(1), version: z.number().int().positive() }),
        z.object({ kind: z.literal("workbench.plugin.publish"), workbenchKey: z.string().min(1) }),
        z.object({ kind: z.literal("workbench.plugin.rollback"), workbenchKey: z.string().min(1) }),
        z.object({ kind: z.literal("workbench.plugin.canary"), workbenchKey: z.string().min(1), canaryVersion: z.number().int().positive(), subjectIds: z.array(z.string().min(1)).max(500) }),
        z.object({ kind: z.literal("schema.publish"), name: z.string().min(1), schemaDef: schemaDefSchema, migrationRunId: z.string().uuid().optional() }),
        z.object({ kind: z.literal("schema.set_active"), name: z.string().min(1), version: z.number().int().positive() }),
        z.object({ kind: z.literal("schema.rollback"), name: z.string().min(1) }),
        z.object({ kind: z.literal("model_routing.upsert"), purpose: z.string().min(1).max(100), primaryModelRef: z.string().min(3), fallbackModelRefs: z.array(z.string().min(3)).max(10).optional(), enabled: z.boolean().optional() }),
        z.object({ kind: z.literal("model_routing.disable"), purpose: z.string().min(1).max(100) }),
        z.object({ kind: z.literal("model_limits.set"), scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), modelChatRpm: z.number().int().positive().max(100000) }),
        z.object({ kind: z.literal("tool_limits.set"), toolRef: z.string().min(3), defaultMaxConcurrency: z.number().int().positive().max(1000) }),
        z.object({ kind: z.literal("artifact_policy.upsert"), scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), downloadTokenExpiresInSec: z.number().int().positive().max(3600), downloadTokenMaxUses: z.number().int().positive().max(10), watermarkHeadersEnabled: z.boolean() }),
      ])
      .parse(req.body);

    const payload =
      body.kind === "tool.set_active"
        ? { name: body.name, toolRef: body.toolRef }
        : body.kind === "tool.enable" || body.kind === "tool.disable"
          ? { toolRef: body.toolRef }
          : body.kind === "policy.cache.invalidate"
            ? { scopeType: (body as any).scopeType, scopeId: (body as any).scopeId, reason: (body as any).reason }
            : body.kind === "policy.version.release"
              ? { name: (body as any).name, version: (body as any).version }
              : body.kind === "policy.publish" || body.kind === "policy.set_active"
                ? { policyId: (body as any).policyId, version: (body as any).version }
                : body.kind === "policy.rollback"
                  ? { policyId: (body as any).policyId }
                  : body.kind === "policy.set_override"
                    ? { policyId: (body as any).policyId, spaceId: (body as any).spaceId, version: (body as any).version }
                    : body.kind === "workbench.plugin.publish" || body.kind === "workbench.plugin.rollback"
                      ? { workbenchKey: (body as any).workbenchKey }
                      : body.kind === "workbench.plugin.canary"
                        ? { workbenchKey: (body as any).workbenchKey, canaryVersion: (body as any).canaryVersion, subjectIds: (body as any).subjectIds }
                        : body.kind === "schema.publish"
                          ? body.migrationRunId
                            ? { name: body.name, schemaDef: body.schemaDef, migrationRunId: body.migrationRunId }
                            : { name: body.name, schemaDef: body.schemaDef }
                          : body.kind === "schema.set_active"
                            ? { name: body.name, version: body.version }
                            : body.kind === "schema.rollback"
                              ? { name: body.name }
                              : body.kind === "ui.page.publish" || body.kind === "ui.page.rollback"
                                ? { pageName: body.pageName }
                                : body.kind === "model_routing.upsert"
                                  ? { purpose: body.purpose, primaryModelRef: body.primaryModelRef, fallbackModelRefs: body.fallbackModelRefs ?? [], enabled: body.enabled ?? true }
                                  : body.kind === "model_routing.disable"
                                    ? { purpose: body.purpose }
                                    : body.kind === "model_limits.set"
                                      ? { scopeType: body.scopeType, scopeId: body.scopeId, modelChatRpm: body.modelChatRpm }
                                      : body.kind === "tool_limits.set"
                                        ? { toolRef: body.toolRef, defaultMaxConcurrency: body.defaultMaxConcurrency }
                                        : { scopeType: body.scopeType, scopeId: body.scopeId, downloadTokenExpiresInSec: body.downloadTokenExpiresInSec, downloadTokenMaxUses: body.downloadTokenMaxUses, watermarkHeadersEnabled: body.watermarkHeadersEnabled };

    try {
      const item = await addChangeSetItem({ pool: app.db, tenantId: subject.tenantId, changesetId: params.id, kind: body.kind, payload });
      req.ctx.audit!.outputDigest = { changesetId: params.id, itemId: item.id, kind: item.kind };
      return { item };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/submit", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.submit" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.submit" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const cs = await submitChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id });
      const suiteIds = await listChangeSetEvalBindings({ pool: app.db, tenantId: subject.tenantId, changesetId: cs.id });
      // Compute eval admission requirement from item kinds
      const items = await listChangeSetItems({ pool: app.db, tenantId: subject.tenantId, changesetId: cs.id });
      const evalAdmissionRequired = items.some((i: any) => {
        const KINDS = (process.env.EVAL_ADMISSION_REQUIRED_KINDS ?? "tool.set_active,tool.enable,policy.,model_routing.,schema.").split(",").map((s: string) => s.trim()).filter(Boolean);
        return KINDS.some((prefix: string) => i.kind === prefix || i.kind.startsWith(prefix));
      });
      const shouldAuto = (isHighRiskChangeSet(cs) || evalAdmissionRequired) && suiteIds.length > 0;
      const evalEnqueue = shouldAuto ? await enqueueChangeSetEvalSuites({ tenantId: subject.tenantId, changesetId: cs.id, suiteIds, requestedBySubjectId: subject.subjectId }) : [];
      req.ctx.audit!.outputDigest = { changesetId: cs.id, evalSuites: suiteIds.length, evalQueued: evalEnqueue.filter((r: any) => r.status === "queued").length };
      return { changeset: cs, evalEnqueue: evalEnqueue.length ? evalEnqueue : undefined };
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/approve", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.approve" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.approve" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const r = await approveChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, approvedBy: subject.subjectId });
      return r;
    } catch (e: any) {
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/release", async (req, reply) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    const mode = q.mode ?? "full";
    setAuditContext(req, { resourceType: "governance", action: mode === "canary" ? "changeset.release_canary" : "changeset.release" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.release" });
    req.ctx.audit!.policyDecision = decision;

    let preflightOut: any | null = null;
    let preflightGates: any[] | null = null;
    try {
      try {
        preflightOut = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, mode });
        const csForGates = preflightOut?.changeset ?? null;
        if (csForGates) {
          const isHighRisk = csForGates.riskLevel === "high" || csForGates.requiredApprovals >= 2;
          const evalRequiredSuiteIds = Array.isArray(preflightOut?.evalGate?.requiredSuiteIds) ? (preflightOut.evalGate.requiredSuiteIds as any[]) : [];
          const evalSuites = Array.isArray(preflightOut?.evalGate?.suites) ? (preflightOut.evalGate.suites as any[]) : [];
          const evalAdmissionRequired = Boolean(preflightOut?.evalGate?.evalAdmissionRequired);
          const evalRequired = (evalRequiredSuiteIds.length > 0 && isHighRisk) || evalAdmissionRequired;
          const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
          const approvalsOk = preflightOut.gate.approvalsCount >= preflightOut.gate.requiredApprovals;
          const plan: any[] = Array.isArray(preflightOut?.plan) ? preflightOut.plan : [];
          const current: any[] = Array.isArray(preflightOut?.currentStateDigest) ? preflightOut.currentStateDigest : [];
          const modelLimits = plan.filter((p) => p?.kind === "model_limits.set");
          const toolLimits = plan.filter((p) => p?.kind === "tool_limits.set");
          const modelPrev = new Map<string, number | null>();
          const toolPrev = new Map<string, number | null>();
          for (const c of current) {
            if (c?.kind === "model.quota_limit") {
              const k = `${String(c.scopeType ?? "")}:${String(c.scopeId ?? "")}`;
              const prevRpm = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).modelChatRpm) : null;
              modelPrev.set(k, Number.isFinite(prevRpm as any) ? (prevRpm as any) : null);
            }
            if (c?.kind === "tool.limit") {
              const k = String(c.toolRef ?? "");
              const prevC = c?.prev && typeof c.prev === "object" ? Number((c.prev as any).defaultMaxConcurrency) : null;
              toolPrev.set(k, Number.isFinite(prevC as any) ? (prevC as any) : null);
            }
          }
          let modelIncreases = 0;
          let modelDecreases = 0;
          let toolIncreases = 0;
          let toolDecreases = 0;
          let modelMaxNextRpm = 0;
          let modelMaxPrevRpm = 0;
          let toolMaxNextC = 0;
          let toolMaxPrevC = 0;
          const deltaSummary: any[] = [];
          for (const p of modelLimits) {
            const scopeType = String(p.scopeType ?? "");
            const scopeId = String(p.scopeId ?? "");
            const next = Number(p.modelChatRpm);
            const k = `${scopeType}:${scopeId}`;
            const prev = modelPrev.has(k) ? modelPrev.get(k)! : null;
            if (Number.isFinite(next)) {
              modelMaxNextRpm = Math.max(modelMaxNextRpm, next);
              if (typeof prev === "number" && Number.isFinite(prev)) modelMaxPrevRpm = Math.max(modelMaxPrevRpm, prev);
            }
            if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
              if (next > prev) modelIncreases += 1;
              else if (next < prev) modelDecreases += 1;
            } else if (Number.isFinite(next)) {
              modelIncreases += 1;
            }
            deltaSummary.push({ kind: "model_limits.set", scopeType, scopeId, next: Number.isFinite(next) ? next : null, prev });
          }
          for (const p of toolLimits) {
            const toolRef = String(p.toolRef ?? "");
            const next = Number(p.defaultMaxConcurrency);
            const prev = toolPrev.has(toolRef) ? toolPrev.get(toolRef)! : null;
            if (Number.isFinite(next)) {
              toolMaxNextC = Math.max(toolMaxNextC, next);
              if (typeof prev === "number" && Number.isFinite(prev)) toolMaxPrevC = Math.max(toolMaxPrevC, prev);
            }
            if (typeof prev === "number" && Number.isFinite(prev) && Number.isFinite(next)) {
              if (next > prev) toolIncreases += 1;
              else if (next < prev) toolDecreases += 1;
            } else if (Number.isFinite(next)) {
              toolIncreases += 1;
            }
            deltaSummary.push({ kind: "tool_limits.set", toolRef, next: Number.isFinite(next) ? next : null, prev });
          }
          const increaseCount = modelIncreases + toolIncreases;
          const quotaStatus = increaseCount > 0 ? "warn" : "pass";
          const deltaDigest8 = sha256Hex(JSON.stringify(deltaSummary.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).slice(0, 8);
          preflightGates = [
            { gateType: "eval_admission", required: evalRequired, status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass", detailsDigest: { requiredSuites: evalRequiredSuiteIds.length, suites: evalSuites.length, failedSuites: evalSuites.filter((e: any) => !e?.passed).length, latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8) } },
            { gateType: "approval", required: preflightOut.gate.requiredApprovals > 0, status: approvalsOk ? "pass" : "fail", detailsDigest: { requiredApprovals: preflightOut.gate.requiredApprovals, approvalsCount: preflightOut.gate.approvalsCount } },
            { gateType: "risk", required: false, status: csForGates.riskLevel === "low" ? "pass" : "warn", detailsDigest: { riskLevel: csForGates.riskLevel } },
            { gateType: "quota", required: false, status: quotaStatus, detailsDigest: { modelLimitsCount: modelLimits.length, toolLimitsCount: toolLimits.length, modelIncreases, modelDecreases, toolIncreases, toolDecreases, modelMaxNextRpm: modelMaxNextRpm || null, modelMaxPrevRpm: modelMaxPrevRpm || null, toolMaxNextConcurrency: toolMaxNextC || null, toolMaxPrevConcurrency: toolMaxPrevC || null, deltaDigest8 } },
          ];
        }
      } catch {
      }

      if (preflightOut) {
        const csForGates = preflightOut?.changeset ?? null;
        const isHighRisk = csForGates ? isHighRiskChangeSet(csForGates) : false;
        const evalRequiredSuiteIds = Array.isArray(preflightOut?.evalGate?.requiredSuiteIds) ? (preflightOut.evalGate.requiredSuiteIds as any[]) : [];
        const evalSuites = Array.isArray(preflightOut?.evalGate?.suites) ? (preflightOut.evalGate.suites as any[]) : [];
        const evalAdmissionRequired = Boolean(preflightOut?.evalGate?.evalAdmissionRequired);
        const evalRequired = (evalRequiredSuiteIds.length > 0 && isHighRisk) || evalAdmissionRequired;
        const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
        if (evalRequired && !evalAllPassed) {
          throw new Error("eval_not_passed");
        }
      }

      const cs = await releaseChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, releasedBy: subject.subjectId, mode });
      req.ctx.audit!.outputDigest = { changesetId: cs.id, mode, gateStatuses: Array.isArray(preflightGates) ? preflightGates.map((g: any) => ({ gateType: g.gateType, status: g.status })) : null };
      app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "ok" });
      return { changeset: cs };
    } catch (e: any) {
      if (String(e?.message ?? e) === "eval_not_passed") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "eval_admission" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "eval_admission" }, gateStatuses: Array.isArray(preflightGates) ? preflightGates.map((g: any) => ({ gateType: g.gateType, status: g.status })) : null, warnings: Array.isArray(preflightOut?.warnings) ? preflightOut.warnings.slice(0, 10) : null };
        throw Errors.evalNotPassed();
      }
      if (String(e?.message ?? e) === "trust_not_verified") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "trust" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "trust" } };
        throw Errors.trustNotVerified();
      }
      if (String(e?.message ?? e) === "scan_not_passed") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "scan" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "scan" } };
        throw Errors.scanNotPassed();
      }
      if (String(e?.message ?? e) === "sbom_not_present") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "sbom" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "sbom" } };
        throw Errors.sbomNotPresent();
      }
      if (String(e?.message ?? e) === "isolation_required") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "isolation" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "isolation" } };
        throw Errors.isolationRequired();
      }
      if (String(e?.message ?? e) === "changeset_mode_not_supported") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "mode" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "mode" } };
        throw Errors.changeSetModeNotSupported();
      }
      {
        const msg = String(e?.message ?? e);
        if (msg.startsWith("schema_migration_required")) {
          const digest8 = msg.includes(":") ? msg.split(":").slice(1).join(":") : "";
          app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
          app.metrics.incGovernanceGateFailed({ gateType: "migration" });
          req.ctx.audit!.errorCategory = "policy_violation";
          req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "migration", compatReportDigest8: digest8 || null } };
          throw Errors.schemaMigrationRequired(digest8 ? `compatReportDigest8=${digest8}` : undefined);
        }
        if (msg.startsWith("schema_breaking_change")) {
          const digest8 = msg.includes(":") ? msg.split(":").slice(1).join(":") : "";
          app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
          app.metrics.incGovernanceGateFailed({ gateType: "schema_compat" });
          req.ctx.audit!.errorCategory = "policy_violation";
          req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "schema_compat", compatReportDigest8: digest8 || null } };
          throw Errors.schemaBreakingChange(digest8 ? `compatReportDigest8=${digest8}` : undefined);
        }
      }
      if (String(e?.message ?? e) === "migration_required") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "migration" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "migration" } };
        throw Errors.migrationRequired();
      }
      if (String(e?.message ?? e) === "contract_not_compatible") {
        app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "denied" });
        app.metrics.incGovernanceGateFailed({ gateType: "contract" });
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { changesetId: params.id, mode, gateFailed: { gateType: "contract" } };
        throw Errors.contractNotCompatible();
      }
      app.metrics.incGovernancePipelineAction({ action: mode === "canary" ? "release.canary" : "release.full", result: "error" });
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/preflight", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ mode: z.enum(["full", "canary"]).optional() }).parse(req.query);
    setAuditContext(req, { resourceType: "governance", action: "changeset.preflight" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const out = await preflightChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, mode: q.mode });
      app.metrics.incGovernancePipelineAction({ action: "preflight", result: "ok" });
      const mode = q.mode ?? "full";
      const cs = (out as any).changeset ?? null;
      const isHighRisk = cs?.riskLevel === "high" || Number(cs?.requiredApprovals ?? 0) >= 2;
      const evalRequiredSuiteIds = Array.isArray((out as any)?.evalGate?.requiredSuiteIds) ? ((out as any).evalGate.requiredSuiteIds as any[]) : [];
      const evalSuites = Array.isArray((out as any)?.evalGate?.suites) ? ((out as any).evalGate.suites as any[]) : [];
      const evalAdmissionRequired = Boolean((out as any)?.evalGate?.evalAdmissionRequired);
      const evalRequired = (evalRequiredSuiteIds.length > 0 && isHighRisk) || evalAdmissionRequired;
      const evalAllPassed = evalSuites.every((e: any) => Boolean(e?.passed));
      const approvalsOk = out.gate.approvalsCount >= out.gate.requiredApprovals;
      const gates = [
        { gateType: "eval_admission", required: evalRequired, status: evalAllPassed ? "pass" : evalRequired ? "fail" : evalSuites.length > 0 ? "warn" : "pass", detailsDigest: { requiredSuites: evalRequiredSuiteIds.length, suites: evalSuites.length, failedSuites: evalSuites.filter((e: any) => !e?.passed).length, latestRunIdsDigest8: sha256Hex(JSON.stringify(evalSuites.map((e: any) => e.latestRunId ?? null))).slice(0, 8) } },
        { gateType: "approval", required: out.gate.requiredApprovals > 0, status: approvalsOk ? "pass" : "fail", detailsDigest: { requiredApprovals: out.gate.requiredApprovals, approvalsCount: out.gate.approvalsCount } },
        { gateType: "risk", required: false, status: cs?.riskLevel === "low" ? "pass" : "warn", detailsDigest: { riskLevel: cs?.riskLevel ?? null } },
      ];
      req.ctx.audit!.outputDigest = { changesetId: cs?.id ?? params.id, mode, planCount: out.plan.length, gateStatuses: gates.map((g: any) => ({ gateType: g.gateType, status: g.status })), warnings: out.warnings.slice(0, 10) };
      return { ...(out as any), gates };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "preflight", result: "error" });
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/promote", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.promote" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.release" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const cs = await promoteChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, promotedBy: subject.subjectId });
      req.ctx.audit!.outputDigest = { changesetId: cs.id, status: cs.status, canaryReleasedAt: cs.canaryReleasedAt, promotedAt: cs.promotedAt };
      app.metrics.incGovernancePipelineAction({ action: "promote", result: "ok" });
      return { changeset: cs };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "promote", result: "error" });
      req.ctx.audit!.outputDigest = { changesetId: params.id };
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.post("/governance/changesets/:id/rollback", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.rollback" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.rollback" });
    req.ctx.audit!.policyDecision = decision;

    try {
      const rb = await rollbackChangeSet({ pool: app.db, tenantId: subject.tenantId, id: params.id, createdBy: subject.subjectId });
      req.ctx.audit!.outputDigest = { changesetId: params.id, rollbackChangeSetId: rb.id, rollbackOf: rb.rollbackOf, status: rb.status };
      app.metrics.incGovernancePipelineAction({ action: "rollback", result: "ok" });
      return { rollback: rb };
    } catch (e: any) {
      app.metrics.incGovernancePipelineAction({ action: "rollback", result: "error" });
      req.ctx.audit!.outputDigest = { changesetId: params.id };
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });
};
