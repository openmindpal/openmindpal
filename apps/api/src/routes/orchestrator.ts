import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1 } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { orchestratorTurnRequestSchema } from "../modules/orchestrator/model";
import { orchestrateChatTurn } from "../modules/orchestrator/orchestrator";
import { createOrchestratorTurn, getOrchestratorTurn } from "../modules/orchestrator/turnRepo";
import { digestParams, sha256Hex } from "../modules/notifications/digest";
import { getToolDefinition, getToolVersionByRef } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { validateToolInput } from "../modules/tools/validate";
import { appendStepToRun, createJobRun, createJobRunStep, listSteps, retryDeadletterStep, retryFailedStep } from "../modules/workflow/jobRepo";
import { createApproval } from "../modules/workflow/approvalRepo";
import { extractTextForPromptInjectionScan, getPromptInjectionDenyTargetsFromEnv, getPromptInjectionModeFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../modules/safety/promptInjectionGuard";
import { getEffectiveToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { createRetrievalLog, searchChunks } from "../modules/knowledge/repo";
import { getTaskState, upsertTaskState } from "../modules/memory/repo";
import { clearSessionContext } from "../modules/memory/sessionContextRepo";
import { orchestrateTurn } from "../modules/orchestrator/orchestrator";

export const orchestratorRoutes: FastifyPluginAsync = async (app) => {
  type ClosedLoopPhase = "planning" | "executing" | "reviewing" | "needs_approval" | "succeeded" | "failed" | "stopped";
  type ClosedLoopNextActionKind = "wait" | "continue" | "needs_approval" | "stop";

  function normalizeStepStatus(v: unknown) {
    const s = String(v ?? "");
    if (["created", "pending", "running", "succeeded", "failed", "deadletter", "canceled"].includes(s)) return s;
    return s || "unknown";
  }

  function buildClosedLoopSummaryV1(params: {
    plan: any;
    steps: any[];
    cursor: number;
    maxSteps: number;
    maxWallTimeMs: number;
    runStatus?: string | null;
  }) {
    const planSteps: any[] = Array.isArray(params.plan?.steps) ? params.plan.steps : [];
    const stepStatuses = planSteps.map((p, i) => {
      const s = params.steps[i] ?? null;
      const status = normalizeStepStatus(s?.status ?? (i < params.cursor ? "created" : "pending"));
      const errorCategory = typeof s?.errorCategory === "string" ? s.errorCategory : null;
      const retryable = Boolean(errorCategory && ["retryable", "timeout", "resource_exhausted"].includes(errorCategory) && ["failed", "deadletter"].includes(status));
      return {
        index: i,
        planStepId: typeof p?.stepId === "string" ? p.stepId : null,
        runStepId: typeof s?.stepId === "string" ? s.stepId : null,
        toolRef: String(p?.toolRef ?? s?.toolRef ?? ""),
        status,
        attempt: typeof s?.attempt === "number" ? s.attempt : 0,
        policySnapshotRef: typeof s?.policySnapshotRef === "string" ? s.policySnapshotRef : null,
        errorCategory,
        retryable,
        inputDigest: s?.inputDigest ?? null,
        outputDigest: s?.outputDigest ?? null,
        lastErrorDigest: s?.lastErrorDigest ?? null,
        updatedAt: s?.updatedAt ?? null,
      };
    });

    const limit = Math.min(params.maxSteps, planSteps.length);
    const runStatus = params.runStatus ? String(params.runStatus) : "";
    let phase: ClosedLoopPhase = "planning";
    if (runStatus === "needs_approval") {
      phase = "needs_approval";
    } else if (params.cursor >= limit) {
      const slice = stepStatuses.slice(0, limit);
      const allSucceeded = slice.length > 0 && slice.every((x) => x.status === "succeeded");
      phase = allSucceeded && params.cursor >= planSteps.length ? "succeeded" : "stopped";
    } else if (params.cursor > 0) {
      const prev = stepStatuses[params.cursor - 1] ?? null;
      if (prev && ["pending", "running", "created"].includes(prev.status)) phase = "executing";
      else if (prev && ["failed", "deadletter", "canceled"].includes(prev.status)) phase = "failed";
      else if (prev && prev.status === "succeeded") phase = "reviewing";
      else phase = "executing";
    }

    let nextAction: { kind: ClosedLoopNextActionKind; reason?: string } = { kind: "continue" };
    if (phase === "needs_approval") nextAction = { kind: "needs_approval", reason: "approval_required" };
    else if (phase === "executing") nextAction = { kind: "wait", reason: "step_pending" };
    else if (phase === "reviewing") nextAction = { kind: "continue", reason: "next_step" };
    else if (phase === "succeeded") nextAction = { kind: "stop", reason: "succeeded" };
    else if (phase === "failed") nextAction = { kind: "stop", reason: "failed" };
    else if (phase === "stopped") nextAction = { kind: "stop", reason: "stopped" };

    const lastIdx = Math.min(params.cursor, stepStatuses.length) - 1;
    const lastStep = lastIdx >= 0 ? stepStatuses[lastIdx] : null;
    if (phase === "failed" && lastStep?.retryable) nextAction = { kind: "continue", reason: "retryable_failed" };
    const stopReason =
      phase === "failed"
        ? "failed"
        : phase === "succeeded"
          ? "plan_end"
          : phase === "stopped"
            ? params.cursor >= limit
              ? "max_steps_or_end"
              : "stopped"
            : undefined;

    return {
      summaryVersion: "v1",
      phase,
      cursor: params.cursor,
      maxSteps: params.maxSteps,
      maxWallTimeMs: params.maxWallTimeMs,
      stepStatuses,
      executionSummary: {
        lastStep: lastStep
          ? {
              index: lastStep.index,
              runStepId: lastStep.runStepId,
              toolRef: lastStep.toolRef,
              status: lastStep.status,
              policySnapshotRef: (lastStep as any).policySnapshotRef ?? null,
              errorCategory: lastStep.errorCategory,
            }
          : null,
        nextAction,
        stopReason,
      },
    };
  }

  function networkPolicyDigest(allowedDomains: string[], rules: any[] | null) {
    const canon = allowedDomains.map((d) => d.trim()).filter(Boolean).sort();
    const rulesCanon = Array.isArray(rules) ? rules : [];
    return {
      allowedDomainsCount: canon.length,
      sha256_8: sha256Hex(canon.join("\n")).slice(0, 8),
      rulesCount: rulesCanon.length,
      rulesSha256_8: sha256Hex(JSON.stringify(rulesCanon)).slice(0, 8),
    };
  }

  app.post("/orchestrator/turn", async (req) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "turn" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = orchestratorTurnRequestSchema.parse(req.body);
    const piMode = getPromptInjectionModeFromEnv();
    const piTarget = "orchestrator:turn";
    const piScan = scanPromptInjection(body.message);
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, false);
    const out = await orchestrateChatTurn({
      app,
      pool: app.db,
      subject,
      message: body.message,
      locale: body.locale ?? req.ctx.locale,
      conversationId: body.conversationId ?? null,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId,
    });
    const toolSuggestions = (out.toolSuggestions ?? []).map((s: any) => ({ ...s, suggestionId: crypto.randomUUID() }));
    if (toolSuggestions.length === 0 && subject.spaceId) {
      const toolRef = await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: "entity.create" });
      if (toolRef) {
        const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
        if (!ver) throw Errors.badRequest("工具版本不存在");
        const def = await getToolDefinition(app.db, subject.tenantId, "entity.create");
        const inputDraft = { schemaName: "core", entityName: "NotePage", payload: { title: "" } };
        validateToolInput(ver.inputSchema, inputDraft);
        toolSuggestions.push({
          toolRef,
          inputDraft,
          scope: def?.scope ?? "write",
          resourceType: def?.resourceType ?? "entity",
          action: def?.action ?? "create",
          riskLevel: def?.riskLevel ?? "high",
          approvalRequired: def?.approvalRequired ?? true,
          idempotencyKey: crypto.randomUUID(),
          suggestionId: crypto.randomUUID(),
        });
      }
    }
    const messageDigest = { len: body.message.length, sha256_8: sha256Hex(body.message).slice(0, 8) };
    const toolSuggestionsDigest = toolSuggestions.map((s: any) => ({
      suggestionId: s.suggestionId,
      toolRef: s.toolRef,
      riskLevel: s.riskLevel,
      approvalRequired: s.approvalRequired,
      idempotencyKey: s.idempotencyKey,
      inputDigest: digestParams(s.inputDraft),
    }));
    let storedToolSuggestionsDigest = toolSuggestionsDigest;
    if (storedToolSuggestionsDigest.length === 0) {
      const fallbackToolRef =
        (await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, name: "entity.create" })) ?? "entity.create@1";
      const sid = crypto.randomUUID();
      storedToolSuggestionsDigest = [
        {
          suggestionId: sid,
          toolRef: fallbackToolRef,
          riskLevel: "high",
          approvalRequired: true,
          idempotencyKey: sid,
          inputDigest: digestParams({}),
        },
      ];
    }

    const turn = await createOrchestratorTurn({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId,
      message: "",
      toolSuggestions: null,
      messageDigest,
      toolSuggestionsDigest: storedToolSuggestionsDigest,
    });

    req.ctx.audit!.outputDigest = {
      turnId: turn.turnId,
      suggestionCount: toolSuggestions.length,
      suggestions: toolSuggestions.map((s: any) => ({ suggestionId: s.suggestionId, toolRef: s.toolRef, riskLevel: s.riskLevel, approvalRequired: s.approvalRequired })),
      ui: out.uiDirective ? { openView: (out.uiDirective as any).openView } : undefined,
      safetySummary: { promptInjection: piSummary },
    };

    return { ...out, turnId: turn.turnId, toolSuggestions };
  });

  app.post("/orchestrator/conversations/clear", async (req) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "conversation.clear" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z.object({ conversationId: z.string().min(1).max(200) }).parse(req.body);
    const deleted = await clearSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, sessionId: body.conversationId });
    req.ctx.audit!.outputDigest = { conversationId: body.conversationId, deleted };
    return { deleted };
  });

  app.post("/orchestrator/closed-loop", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z
      .object({
        goal: z.string().min(1).max(5000),
        purpose: z.string().min(1).max(100).optional(),
        constraints: z
          .object({
            allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
          })
          .optional(),
        retriever: z
          .object({
            query: z.string().min(1).max(5000).optional(),
            limit: z.number().int().positive().max(20).optional(),
          })
          .optional(),
        limits: z
          .object({
            maxSteps: z.number().int().positive().max(10).optional(),
            maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const purpose = body.purpose ?? "default";
    const goal = body.goal;
    const maxSteps = body.limits?.maxSteps ?? 3;
    const maxWallTimeMs = body.limits?.maxWallTimeMs ?? 5 * 60 * 1000;
    const allowedToolsList = Array.isArray(body.constraints?.allowedTools) ? body.constraints?.allowedTools.map((x) => String(x).trim()).filter(Boolean) : [];
    const allowedTools = allowedToolsList.length ? new Set(allowedToolsList) : null;

    const jobRun = await createJobRun({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "agent.run",
      runToolRef: "orchestrator.closed_loop@2",
      inputDigest: { purpose, goalLen: goal.length, limits: { maxSteps, maxWallTimeMs } },
      createdBySubjectId: subject.subjectId,
      trigger: "api",
    });
    const runId = jobRun.run.runId;
    const jobId = jobRun.job.jobId;
    const retrieverQuery = body.retriever?.query ?? goal;
    const retrieverLimit = body.retriever?.limit ?? 5;

    function pickActionFromGoal(goalText: string) {
      const raw = goalText.trim();
      if (!raw.startsWith("{")) return null;
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
        const toolRef = typeof (obj as any).toolRef === "string" ? String((obj as any).toolRef) : "";
        const input = (obj as any).input;
        const idempotencyKey = typeof (obj as any).idempotencyKey === "string" ? String((obj as any).idempotencyKey) : null;
        if (!toolRef) return null;
        return { toolRef, input, idempotencyKey };
      } catch {
        return null;
      }
    }

    const t0 = Date.now();
    let plan: any = { version: "v3", goal, purpose, limits: { maxSteps, maxWallTimeMs }, constraints: allowedTools ? { allowedTools: allowedToolsList } : undefined, steps: [] };
    await requirePermission({ req, resourceType: "memory", action: "task_state" });

    await requirePermission({ req, resourceType: "knowledge", action: "search" });
    const hits = await searchChunks({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, query: retrieverQuery, limit: retrieverLimit });
    const rankPolicy = "substring_pos_created_at";
    const evidenceRefs = hits.map((h) => ({
      sourceRef: { documentId: h.document_id, version: h.document_version, chunkId: h.id },
      snippetDigest: { len: String(h.snippet ?? "").length, sha256_8: sha256Hex(String(h.snippet ?? "")).slice(0, 8) },
      location: { chunkIndex: h.chunk_index, startOffset: h.start_offset, endOffset: h.end_offset },
      rankReason: { kind: rankPolicy, matchPos: typeof h.match_pos === "number" ? h.match_pos : null },
    }));
    const retrievalLogId = await createRetrievalLog({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      queryDigest: { queryLen: retrieverQuery.length, rankPolicy },
      filtersDigest: { spaceId: subject.spaceId, runId, source: "orchestrator.closed-loop" },
      candidateCount: hits.length,
      citedRefs: evidenceRefs.map((e) => e.sourceRef),
    });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: "retrieved",
      plan,
      artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, evidenceRefs },
    });

    const approvalRequired = /(^|\\b)(delete|drop|truncate|rm\\s+-rf|destroy|erase)\\b/i.test(goal);
    const guard = approvalRequired
      ? { allow: false, approvalRequired: true, reasonSummary: "high_risk_intent" }
      : { allow: true, approvalRequired: false, reasonSummary: "ok" };
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: "guarded",
      plan,
      artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard },
    });

    const explicit = guard.allow ? pickActionFromGoal(goal) : null;
    const suggestions = explicit
      ? [{ toolRef: explicit.toolRef, inputDraft: explicit.input ?? {}, idempotencyKey: explicit.idempotencyKey ?? null }]
      : (await orchestrateTurn({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, message: goal })).toolSuggestions ?? [];

    const planSteps: any[] = [];
    for (const s of suggestions.slice(0, maxSteps)) {
      const rawToolRef = typeof (s as any)?.toolRef === "string" ? String((s as any).toolRef) : "";
      if (!rawToolRef) continue;
      const at = rawToolRef.lastIndexOf("@");
      const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
      const effToolRef = at > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: toolName });
      if (!effToolRef) continue;
      if (allowedTools && !allowedTools.has(toolName) && !allowedTools.has(rawToolRef) && !allowedTools.has(effToolRef)) continue;

      const ver = await getToolVersionByRef(app.db, subject.tenantId, effToolRef);
      if (!ver || String(ver.status) !== "released") continue;

      const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, toolRef: effToolRef });
      if (!enabled) continue;

      const def = await getToolDefinition(app.db, subject.tenantId, toolName);
      const approvalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
      const inputDraft = typeof (s as any)?.inputDraft === "object" && (s as any).inputDraft && !Array.isArray((s as any).inputDraft) ? (s as any).inputDraft : {};
      planSteps.push({ stepId: crypto.randomUUID(), actorRole: "executor", kind: "tool", toolRef: effToolRef, inputDraft, approvalRequired });
    }

    if (!planSteps.length) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({
        errorCode: "ORCH_PLAN_EMPTY",
        message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" },
        traceId: req.ctx.traceId,
      });
    }

    plan = { version: "v3", goal, purpose, limits: { maxSteps, maxWallTimeMs }, constraints: allowedTools ? { allowedTools: allowedToolsList } : undefined, steps: planSteps };
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: "planned",
      plan,
      artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard, cursor: 0 },
    });

    const cursor = 0;
    const stepPlan = planSteps[cursor]!;
    let execution: any = guard.allow ? { status: "skipped", reason: "no_action" } : { status: "blocked", reason: "approval_required" };
    if (guard.allow) {
      try {
        const toolRef = String(stepPlan.toolRef);
        const at = toolRef.lastIndexOf("@");
        const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
        const def = await getToolDefinition(app.db, subject.tenantId, toolName);
        const scope = def?.scope ?? null;
        const resourceType = def?.resourceType ?? null;
        const actionName = def?.action ?? null;
        const idempotencyRequired = def?.idempotencyRequired ?? null;
        if (!scope || !resourceType || !actionName || idempotencyRequired === null) throw Errors.badRequest("工具契约缺失");

        if (toolName === "memory.read") await requirePermission({ req, resourceType: "memory", action: "read" });
        if (toolName === "memory.write") await requirePermission({ req, resourceType: "memory", action: "write" });

        const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
        if (!ver) throw Errors.badRequest("工具版本不存在");
        validateToolInput(ver.inputSchema, stepPlan.inputDraft);

        const opDecision = await requirePermission({ req, resourceType, action: actionName });
        const idempotencyKey = scope === "write" && idempotencyRequired ? `idem-orch-${runId}-${cursor + 1}` : null;

        const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
        const effAllowedDomains = effPol?.allowedDomains ?? [];
        const effRules = (effPol as any)?.rules ?? [];
        const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
        const env: CapabilityEnvelopeV1 = {
          format: "capabilityEnvelope.v1",
          dataDomain: {
            tenantId: subject.tenantId,
            spaceId: subject.spaceId ?? null,
            subjectId: subject.subjectId ?? null,
            toolContract: { scope, resourceType, action: actionName, fieldRules: (opDecision as any).fieldRules ?? null, rowFilters: (opDecision as any).rowFilters ?? null },
          },
          secretDomain: { connectorInstanceIds: [] },
          egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
          resourceDomain: { limits: normalizeRuntimeLimitsV1({}) },
        };
        const effNetDigest = networkPolicyDigest(env.egressDomain.networkPolicy.allowedDomains, env.egressDomain.networkPolicy.rules ?? null);

        const step = await appendStepToRun({
          pool: app.db,
          tenantId: subject.tenantId,
          jobType: "agent.run",
          runId,
          toolRef,
          policySnapshotRef: opDecision.snapshotRef,
          masterKey: app.cfg.secrets.masterKey,
          input: {
            kind: "agent.run.step",
            planStepId: stepPlan.stepId,
            actorRole: "executor",
            dependsOn: [],
            toolRef,
            idempotencyKey: idempotencyKey ?? undefined,
            toolContract: {
              scope,
              resourceType,
              action: actionName,
              idempotencyRequired,
              riskLevel: def?.riskLevel,
              approvalRequired: def?.approvalRequired,
              fieldRules: env.dataDomain.toolContract.fieldRules ?? null,
              rowFilters: env.dataDomain.toolContract.rowFilters ?? null,
            },
            input: stepPlan.inputDraft,
            limits: env.resourceDomain.limits,
            networkPolicy: env.egressDomain.networkPolicy,
            capabilityEnvelope: env,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            traceId: req.ctx.traceId,
          },
        });

        const toolApprovalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
        if (toolApprovalRequired) {
          await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, runId]);
          await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, runId]);
          const approval = await createApproval({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId ?? null,
            runId,
            stepId: step.stepId,
            requestedBySubjectId: subject.subjectId,
            toolRef,
            policySnapshotRef: opDecision.snapshotRef ?? null,
            inputDigest: step.inputDigest ?? null,
          });
          await insertAuditEvent(app.db, {
            subjectId: subject.subjectId,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            resourceType: "workflow",
            action: "approval.requested",
            policyDecision: opDecision,
            inputDigest: { approvalId: approval.approvalId, toolRef },
            outputDigest: { status: "pending", runId, stepId: step.stepId },
            idempotencyKey: idempotencyKey ?? undefined,
            result: "success",
            traceId: req.ctx.traceId,
            requestId: req.ctx.requestId,
            runId,
            stepId: step.stepId,
          });
          execution = { status: "blocked", reason: "approval_required", toolRef, runId, stepId: step.stepId, approvalId: approval.approvalId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
        } else {
          await app.queue.add("step", { jobId, runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
          execution = { status: "queued", toolRef, runId, stepId: step.stepId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
        }
      } catch (err: any) {
        execution = { status: "failed", reason: "executor_error", errorDigest: { message: String(err?.message ?? err) } };
      }
    }

    const latencyMs = Date.now() - t0;
    const stepsAfter = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor: 1, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard, execution, cursor: 1, latencyMs, maxWallTimeMs, maxSteps, closedLoop },
    });

    req.ctx.audit!.inputDigest = { purpose, goalLen: goal.length, retrieverQueryLen: retrieverQuery.length, retrieverLimit, limits: { maxSteps, maxWallTimeMs } };
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor: 1, nextAction: closedLoop.executionSummary.nextAction, latencyMs };
    return { runId, plan, phase: closedLoop.phase, cursor: 1, nextAction: closedLoop.executionSummary.nextAction, closedLoop, retrievalLogId, evidenceRefs, guard, execution, latencyMs };
  });

  app.post("/orchestrator/closed-loop/continue", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }

    const plan: any = state.plan;
    const stepsPlan: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;

    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const createdAtMs = Date.parse(String(state.createdAt ?? ""));
    const elapsedMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : null;
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > maxWallTimeMs) {
      const base = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      const closedLoop = {
        ...base,
        phase: "stopped" as const,
        executionSummary: { ...base.executionSummary, nextAction: { kind: "stop" as const, reason: "max_wall_time" }, stopReason: "max_wall_time" },
      };
      await upsertTaskState({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId,
        phase: closedLoop.phase,
        plan,
        artifactsDigest: { ...artifacts, cursor, elapsedMs, maxWallTimeMs, maxSteps, closedLoop },
      });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, elapsedMs, maxWallTimeMs };
      return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, elapsedMs, maxWallTimeMs };
    }
    if (cursor >= Math.min(maxSteps, stepsPlan.length)) {
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      await upsertTaskState({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId,
        phase: closedLoop.phase,
        plan,
        artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop },
      });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
      return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
    }

    if (cursor > 0) {
      const prev = steps[cursor - 1] ?? null;
      const prevStatus = String((prev as any)?.status ?? "");
      if (prevStatus && prevStatus !== "succeeded") {
        const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId,
          phase: closedLoop.phase,
          plan,
          artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop },
        });
        req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
        return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
      }
    }

    const t0 = Date.now();
    const stepPlan = stepsPlan[cursor] ?? null;
    if (!stepPlan) {
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      await upsertTaskState({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId,
        phase: closedLoop.phase,
        plan,
        artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop },
      });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
      return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
    }

    const toolRef = String(stepPlan.toolRef ?? "");
    const at = toolRef.lastIndexOf("@");
    const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
    const allowed = Array.isArray((plan as any)?.constraints?.allowedTools) ? ((plan as any).constraints.allowedTools as any[]).map((x) => String(x).trim()).filter(Boolean) : [];
    if (allowed.length) {
      const set = new Set(allowed);
      if (!set.has(toolName) && !set.has(toolRef)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({
          errorCode: "ORCH_PLAN_EMPTY",
          message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" },
          traceId: req.ctx.traceId,
        });
      }
    }
    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = def?.scope ?? null;
    const resourceType = def?.resourceType ?? null;
    const actionName = def?.action ?? null;
    const idempotencyRequired = def?.idempotencyRequired ?? null;
    if (!scope || !resourceType || !actionName || idempotencyRequired === null) throw Errors.badRequest("工具契约缺失");

    if (toolName === "memory.read") await requirePermission({ req, resourceType: "memory", action: "read" });
    if (toolName === "memory.write") await requirePermission({ req, resourceType: "memory", action: "write" });

    const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
    if (!ver) throw Errors.badRequest("工具版本不存在");
    validateToolInput(ver.inputSchema, stepPlan.inputDraft ?? {});

    const opDecision = await requirePermission({ req, resourceType, action: actionName });
    const idempotencyKey = scope === "write" && idempotencyRequired ? `idem-orch-${runId}-${cursor + 1}` : null;

    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
    const env: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId ?? null, toolContract: { scope, resourceType, action: actionName, fieldRules: (opDecision as any).fieldRules ?? null, rowFilters: (opDecision as any).rowFilters ?? null } },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
      resourceDomain: { limits: normalizeRuntimeLimitsV1(limits) },
    };
    const effNetDigest = networkPolicyDigest(env.egressDomain.networkPolicy.allowedDomains, env.egressDomain.networkPolicy.rules ?? null);

    const step = await appendStepToRun({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "agent.run",
      runId,
      toolRef,
      policySnapshotRef: opDecision.snapshotRef,
      masterKey: app.cfg.secrets.masterKey,
      input: {
        kind: "agent.run.step",
        planStepId: String(stepPlan.stepId ?? crypto.randomUUID()),
        actorRole: "executor",
        dependsOn: [],
        toolRef,
        idempotencyKey: idempotencyKey ?? undefined,
        toolContract: {
          scope,
          resourceType,
          action: actionName,
          idempotencyRequired,
          riskLevel: def?.riskLevel,
          approvalRequired: def?.approvalRequired,
          fieldRules: opDecision.fieldRules ?? null,
          rowFilters: opDecision.rowFilters ?? null,
        },
        input: stepPlan.inputDraft ?? {},
        limits: {},
        networkPolicy: effNetworkPolicy,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
    });

    const toolApprovalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
    let execution: any;
    if (toolApprovalRequired) {
      await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, runId]);
      await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, runId]);
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef,
        policySnapshotRef: opDecision.snapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
      });
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "workflow",
        action: "approval.requested",
        policyDecision: opDecision,
        inputDigest: { approvalId: approval.approvalId, toolRef },
        outputDigest: { status: "pending", runId, stepId: step.stepId },
        idempotencyKey: idempotencyKey ?? undefined,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        runId,
        stepId: step.stepId,
      });
      execution = { status: "blocked", reason: "approval_required", toolRef, runId, stepId: step.stepId, approvalId: approval.approvalId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
    } else {
      const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, runId]);
      const jobId = jobRes.rowCount ? String(jobRes.rows[0].job_id ?? "") : "";
      if (!jobId) {
        req.ctx.audit!.errorCategory = "internal_error";
        return reply.status(500).send({ errorCode: "INTERNAL_ERROR", message: { "zh-CN": "Job 缺失", "en-US": "Job missing" }, traceId: req.ctx.traceId });
      }
      await app.queue.add("step", { jobId, runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
      execution = { status: "queued", toolRef, runId, stepId: step.stepId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
    }

    const latencyMs = Date.now() - t0;
    const nextCursor = cursor + 1;
    const stepsAfter = await listSteps(app.db, runId);
    const runStatusRes2 = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus2 = runStatusRes2.rowCount ? String((runStatusRes2.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor: nextCursor, maxSteps, maxWallTimeMs, runStatus: runStatus2 });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { ...artifacts, execution, cursor: nextCursor, latencyMs, maxWallTimeMs, maxSteps, closedLoop },
    });
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, latencyMs };
    return { runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, execution, latencyMs };
  });

  app.post("/orchestrator/closed-loop/retry", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const steps = await listSteps(app.db, runId);
    const idx = cursor > 0 ? cursor - 1 : 0;
    const target = steps[idx] ?? null;
    if (!target?.stepId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Step 不存在", "en-US": "Step not found" }, traceId: req.ctx.traceId });
    }
    const status = normalizeStepStatus(target.status);
    let retried: any = null;
    if (status === "deadletter") retried = await retryDeadletterStep({ pool: app.db, tenantId: subject.tenantId, stepId: target.stepId });
    else if (status === "failed") retried = await retryFailedStep({ pool: app.db, tenantId: subject.tenantId, stepId: target.stepId });
    else {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "ORCH_CANNOT_RETRY", message: { "zh-CN": "当前步骤不可重试", "en-US": "Step cannot be retried" }, traceId: req.ctx.traceId });
    }
    if (!retried) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "ORCH_CANNOT_RETRY", message: { "zh-CN": "当前步骤不可重试", "en-US": "Step cannot be retried" }, traceId: req.ctx.traceId });
    }

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, runId]);
    const jobId = jobRes.rowCount ? String(jobRes.rows[0].job_id ?? "") : "";
    if (!jobId) {
      req.ctx.audit!.errorCategory = "internal_error";
      return reply.status(500).send({ errorCode: "INTERNAL_ERROR", message: { "zh-CN": "Job 缺失", "en-US": "Job missing" }, traceId: req.ctx.traceId });
    }
    const bj = await app.queue.add("step", { jobId, runId, stepId: retried.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String(bj.id), retried.stepId]);

    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const stepsAfter = await listSteps(app.db, runId);
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop },
    });
    req.ctx.audit!.outputDigest = { runId, cursor, stepId: retried.stepId, phase: closedLoop.phase, nextAction: closedLoop.executionSummary.nextAction };
    return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, stepId: retried.stepId };
  });

  app.post("/orchestrator/closed-loop/skip", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const stepsPlan: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const nextCursor = Math.min(cursor + 1, Math.min(maxSteps, stepsPlan.length));
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor: nextCursor, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { ...artifacts, cursor: nextCursor, maxWallTimeMs, maxSteps, closedLoop },
    });
    req.ctx.audit!.outputDigest = { runId, fromCursor: cursor, toCursor: nextCursor, phase: closedLoop.phase, nextAction: closedLoop.executionSummary.nextAction };
    return { runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
  });

  app.post("/orchestrator/closed-loop/stop", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const base = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
    const closedLoop = { ...base, phase: "stopped" as const, executionSummary: { ...base.executionSummary, nextAction: { kind: "stop" as const, reason: "user_stop" } } };
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop },
    });
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
    return { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
  });

  app.post("/orchestrator/execute", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .union([
        z.object({
          toolRef: z.string().min(3),
          input: z.unknown(),
          idempotencyKey: z.string().min(3).optional(),
          limits: z.unknown().optional(),
          networkPolicy: z.unknown().optional(),
        }),
        z.object({
          turnId: z.string().min(10),
          suggestionId: z.string().min(10),
          input: z.unknown(),
          idempotencyKey: z.string().min(3).optional(),
          limits: z.unknown().optional(),
          networkPolicy: z.unknown().optional(),
        }),
      ])
      .parse(req.body);

    const bindTurnId = "turnId" in body ? body.turnId : null;
    const bindSuggestionId = "suggestionId" in body ? body.suggestionId : null;

    let rawToolRef: string;
    if ("toolRef" in body) {
      rawToolRef = body.toolRef;
    } else {
      const turn = await getOrchestratorTurn({ pool: app.db, tenantId: subject.tenantId, turnId: body.turnId });
      if (!turn || turn.spaceId !== subject.spaceId || turn.subjectId !== subject.subjectId) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Turn 不存在", "en-US": "Turn not found" }, traceId: req.ctx.traceId });
      }
      const list = Array.isArray(turn.toolSuggestionsDigest) ? turn.toolSuggestionsDigest : [];
      const s = list.find((x: any) => x?.suggestionId === body.suggestionId);
      const toolRef0 = s?.toolRef;
      if (!s) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Suggestion 不存在", "en-US": "Suggestion not found" }, traceId: req.ctx.traceId });
      }
      if (typeof toolRef0 !== "string" || !toolRef0.trim()) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "ORCH_SUGGESTION_MISMATCH", message: { "zh-CN": "Suggestion 绑定不一致", "en-US": "Suggestion binding mismatch" }, traceId: req.ctx.traceId });
      }
      rawToolRef = toolRef0;
    }

    const idx = rawToolRef.lastIndexOf("@");
    const toolName = idx > 0 ? rawToolRef.slice(0, idx) : rawToolRef;
    const toolRef =
      idx > 0
        ? rawToolRef
        : await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: toolName });
    if (!toolRef) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具版本不存在", "en-US": "Tool version not found" }, traceId: req.ctx.traceId });
    }

    const idempotencyKeyHeader =
      (req.headers["idempotency-key"] as string | undefined) ?? (req.headers["x-idempotency-key"] as string | undefined) ?? undefined;

    setAuditContext(req, { resourceType: "orchestrator", action: "execute", toolRef, idempotencyKey: body.idempotencyKey ?? idempotencyKeyHeader });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "execute" });
    req.ctx.audit!.policyDecision = decision;

    const piMode = getPromptInjectionModeFromEnv();
    const piDenyTargets = getPromptInjectionDenyTargetsFromEnv();
    const piTarget = "orchestrator:execute";
    const piText = extractTextForPromptInjectionScan({ toolRef: rawToolRef, input: body.input });
    const piScan = scanPromptInjection(piText);
    const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, mode: piMode, target: piTarget, denyTargets: piDenyTargets });
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
    if (piDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { safetySummary: { decision: "denied", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary } };
      throw Errors.safetyPromptInjectionDenied();
    }

    const ver = await getToolVersionByRef(app.db, subject.tenantId, toolRef);
    if (!ver) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具版本不存在", "en-US": "Tool version not found" }, traceId: req.ctx.traceId });
    }
    if (ver.status !== "released") {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(403).send({ errorCode: "TOOL_NOT_RELEASED", message: { "zh-CN": "工具未发布，已拒绝", "en-US": "Tool is not released" }, traceId: req.ctx.traceId });
    }

    if (!["entity.create", "entity.update", "memory.read", "memory.write", "knowledge.search"].includes(toolName)) {
      if (!ver.artifactRef) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
    }

    if (toolName === "memory.read") {
      await requirePermission({ req, resourceType: "memory", action: "read" });
    }
    if (toolName === "memory.write") {
      await requirePermission({ req, resourceType: "memory", action: "write" });
    }

    const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, toolRef });
    if (!enabled) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.toolDisabled();
    }

    validateToolInput(ver.inputSchema, body.input);

    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = def?.scope ?? null;
    const resourceType = def?.resourceType ?? null;
    const action = def?.action ?? null;
    const idempotencyRequired = def?.idempotencyRequired ?? null;
    if (!scope || !resourceType || !action || idempotencyRequired === null) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("工具契约缺失");
    }

    const opDecision = await requirePermission({ req, resourceType, action });

    let idempotencyKey = body.idempotencyKey ?? idempotencyKeyHeader ?? null;
    if (scope === "write" && idempotencyRequired && !idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
    }

    let limits: any = body.limits ?? null;
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) limits = {};

    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
    const env: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: { tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId ?? null, toolContract: { scope, resourceType, action, fieldRules: (opDecision as any).fieldRules ?? null, rowFilters: (opDecision as any).rowFilters ?? null } },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
      resourceDomain: { limits: normalizeRuntimeLimitsV1(limits) },
    };
    const effNetDigest = networkPolicyDigest(env.egressDomain.networkPolicy.allowedDomains, env.egressDomain.networkPolicy.rules ?? null);

    const { job, run, step } = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "tool.execute",
      toolRef,
      policySnapshotRef: opDecision.snapshotRef,
      idempotencyKey: idempotencyKey ?? undefined,
      createdBySubjectId: subject.subjectId,
      trigger: "orchestrator",
      masterKey: app.cfg.secrets.masterKey,
      input: {
        toolRef,
        toolContract: {
          scope,
          resourceType,
          action,
          idempotencyRequired,
          riskLevel: def?.riskLevel,
          approvalRequired: def?.approvalRequired,
          fieldRules: env.dataDomain.toolContract.fieldRules ?? null,
          rowFilters: env.dataDomain.toolContract.rowFilters ?? null,
        },
        input: body.input,
        limits: env.resourceDomain.limits,
        networkPolicy: env.egressDomain.networkPolicy,
        capabilityEnvelope: env,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
    });

    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };

    const approvalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
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
        policySnapshotRef: opDecision.snapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
      });
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "workflow",
        action: "approval.requested",
        policyDecision: opDecision,
        inputDigest: { approvalId: approval.approvalId, toolRef },
        outputDigest: { status: "pending", runId: run.runId, stepId: step.stepId },
        idempotencyKey: idempotencyKey ?? undefined,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        runId: run.runId,
        stepId: step.stepId,
      });
      req.ctx.audit!.outputDigest = {
        status: "needs_approval",
        toolRef,
        runId: run.runId,
        stepId: step.stepId,
        approvalId: approval.approvalId,
        turnId: bindTurnId ?? undefined,
        suggestionId: bindSuggestionId ?? undefined,
        safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
        runtimePolicy: { networkPolicyDigest: effNetDigest },
      };
      return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, approvalId: approval.approvalId, idempotencyKey, turnId: bindTurnId ?? undefined, suggestionId: bindSuggestionId ?? undefined, receipt: { ...receipt, status: "needs_approval" as const } };
    }

    await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    req.ctx.audit!.outputDigest = {
      status: "queued",
      toolRef,
      runId: run.runId,
      stepId: step.stepId,
      turnId: bindTurnId ?? undefined,
      suggestionId: bindSuggestionId ?? undefined,
      safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
      runtimePolicy: { networkPolicyDigest: effNetDigest },
    };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, idempotencyKey, turnId: bindTurnId ?? undefined, suggestionId: bindSuggestionId ?? undefined, receipt };
  });
};
