import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { resolvePromptInjectionPolicy, resolveSupplyChainPolicy, supplyChainGate as runSupplyChainGate } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { toolPublishSchema } from "../modules/tools/toolModel";
import { getToolDefinition, getToolVersionByRef, listToolDefinitions, listToolVersions, publishToolVersion } from "../modules/tools/toolRepo";
import { assertManifestConsistent, computeDepsDigest, loadSkillManifest, parseTrustedSkillPublicKeys, resolveArtifactDir, verifySkillManifestTrustWithKeys } from "../modules/tools/skillPackage";
import { computeSkillSbomV1, resolveSkillArtifactDir, scanSkillDependencies } from "../modules/tools/skillArtifactRegistry";
import { validateToolInput } from "../modules/tools/validate";
import { getRunForSpace, listSteps } from "../modules/workflow/jobRepo";
import { getActiveToolOverride, getActiveToolRef, listActiveToolOverrides, listActiveToolRefs } from "../modules/governance/toolGovernanceRepo";
import { getEnabledSkillRuntimeRunner, listActiveSkillTrustedKeys } from "../modules/governance/skillRuntimeRepo";
import { extractTextForPromptInjectionScan, getPromptInjectionPolicyFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../lib/promptInjection";
import { getEffectiveSafetyPolicyVersion } from "../lib/safetyContract";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload, submitNewToolRun } from "../kernel/executionKernel";

export const toolRoutes: FastifyPluginAsync = async (app) => {
  function isValidUrl(u: string) {
    try {
      new URL(u);
      return true;
    } catch {
      return false;
    }
  }

  app.get("/tools", async (req) => {
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const tools = await listToolDefinitions(app.db, subject.tenantId);
    const actives = await listActiveToolRefs({ pool: app.db, tenantId: subject.tenantId });
    const map = new Map(actives.map((a) => [a.name, a.activeToolRef]));
    const overrides = subject.spaceId ? await listActiveToolOverrides({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId }) : [];
    const oMap = new Map(overrides.map((o) => [o.name, o.activeToolRef]));
    return {
      tools: tools.map((t) => {
        const activeToolRef = map.get(t.name) ?? null;
        const effectiveActiveToolRef = oMap.get(t.name) ?? activeToolRef;
        return { ...t, activeToolRef, effectiveActiveToolRef };
      }),
    };
  });

  app.get("/tools/:name", async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const def = await getToolDefinition(app.db, subject.tenantId, params.name);
    if (!def) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具不存在", "en-US": "Tool not found" }, traceId: req.ctx.traceId });
    const versions = await listToolVersions(app.db, subject.tenantId, params.name);
    const active = await getActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name });
    const activeToolRef = active?.activeToolRef ?? null;
    const override = subject.spaceId ? await getActiveToolOverride({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: params.name }) : null;
    const effectiveActiveToolRef = override?.activeToolRef ?? activeToolRef;
    return { tool: { ...def, activeToolRef, effectiveActiveToolRef }, versions };
  });

  app.post("/tools/:name/publish", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "publish", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "tool", action: "publish" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const publish = toolPublishSchema.parse(req.body);

    const existing = await getToolDefinition(app.db, subject.tenantId, params.name);
    const scope = publish.scope ?? existing?.scope ?? null;
    const resourceType = publish.resourceType ?? existing?.resourceType ?? null;
    const action = publish.action ?? existing?.action ?? null;
    const idempotencyRequired = publish.idempotencyRequired ?? existing?.idempotencyRequired ?? null;
    if (!scope) throw Errors.badRequest("缺少 scope");
    if (!resourceType) throw Errors.badRequest("缺少 resourceType");
    if (!action) throw Errors.badRequest("缺少 action");
    if (idempotencyRequired === null) throw Errors.badRequest("缺少 idempotencyRequired");

    const riskLevel = publish.riskLevel ?? existing?.riskLevel ?? "low";
    const approvalRequired = publish.approvalRequired ?? existing?.approvalRequired ?? false;
    let depsDigest = publish.depsDigest;
    const artifactRef = publish.artifactId ? `artifact:${publish.artifactId}` : publish.artifactRef;
    let scanSummary: any = null;
    let trustSummary: any = null;
    let sbomSummary: any = null;
    let sbomDigest: string | null = null;
    const hasArtifactChange = Boolean(publish.artifactId || publish.artifactRef || publish.depsDigest);
    if (artifactRef) {
      try {
        const artifactDir = publish.artifactId ? resolveSkillArtifactDir(publish.artifactId) : resolveArtifactDir(artifactRef);
        const loaded = await loadSkillManifest(artifactDir);
        assertManifestConsistent({
          toolName: params.name,
          expectedContract: { scope, resourceType, action, idempotencyRequired: Boolean(idempotencyRequired), riskLevel, approvalRequired: Boolean(approvalRequired) },
          expectedSchemas: { inputSchema: publish.inputSchema, outputSchema: publish.outputSchema },
          manifest: loaded.manifest,
        });
        if (!depsDigest) depsDigest = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
        if (depsDigest && publish.depsDigest && depsDigest !== publish.depsDigest) throw new Error("depsDigest 不匹配");
        const activeKeys = await listActiveSkillTrustedKeys({ pool: app.db as any, tenantId: subject.tenantId });
        const keyIdToPem: Record<string, string> = {};
        for (const k of activeKeys) keyIdToPem[k.keyId] = k.publicKeyPem;
        const trustedKeys = parseTrustedSkillPublicKeys({ keyIdToPem });
        const trust = verifySkillManifestTrustWithKeys({ toolName: params.name, depsDigest, manifest: loaded.manifest, trustedKeys });
        trustSummary = {
          status: trust.status,
          reason: (trust as any).reason ?? null,
          signature: loaded.manifest?.signature ? { alg: loaded.manifest.signature.alg, keyId: loaded.manifest.signature.keyId, signedDigest: loaded.manifest.signature.signedDigest } : null,
          verifiedAt: new Date().toISOString(),
        };
        if (trust.status === "untrusted") {
          req.ctx.audit!.errorCategory = "policy_violation";
          throw Errors.trustNotVerified();
        }
        scanSummary = await scanSkillDependencies({ artifactDir });
        const mode = String(scanSummary?.mode ?? "").toLowerCase();
        const status = String(scanSummary?.status ?? "").toLowerCase();
        const vulns = scanSummary?.vulnerabilities ?? null;
        const crit = Number(vulns?.critical ?? 0) || 0;
        const high = Number(vulns?.high ?? 0) || 0;
        if (mode === "deny") {
          if (status === "error") {
            req.ctx.audit!.errorCategory = "policy_violation";
            throw Errors.scanNotPassed();
          }
          if (status === "ok" && (crit > 0 || high > 0)) {
            req.ctx.audit!.errorCategory = "policy_violation";
            throw Errors.scanNotPassed();
          }
        }
        const sb = await computeSkillSbomV1({ artifactDir, depsDigest, manifestSummary: { toolName: params.name, depsDigest, artifactRef } });
        sbomSummary = sb.sbomSummary;
        sbomDigest = sb.sbomDigest;
      } catch (e: any) {
        if (e && typeof e === "object" && "errorCode" in e) throw e;
        throw Errors.badRequest(String(e?.message ?? e));
      }
    }

    if (
      !publish.inputSchema &&
      !publish.outputSchema &&
      !publish.displayName &&
      !publish.description &&
      !publish.scope &&
      !publish.resourceType &&
      !publish.action &&
      publish.idempotencyRequired === undefined &&
      !publish.riskLevel &&
      publish.approvalRequired === undefined &&
      !hasArtifactChange
    ) {
      throw Errors.badRequest("发布内容为空");
    }

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const version = await publishToolVersion({
        pool: client,
        tenantId: subject.tenantId,
        name: params.name,
        publish: { ...publish, depsDigest, artifactRef, scanSummary, trustSummary, sbomSummary, sbomDigest: sbomDigest ?? undefined },
      });
      req.ctx.audit!.outputDigest = { toolRef: version.toolRef, name: version.name, version: version.version };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { toolRef: version.toolRef, version };
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

  app.get("/tools/versions/:toolRef", async (req, reply) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const ver = await getToolVersionByRef(app.db, subject.tenantId, params.toolRef);
    if (!ver) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "工具版本不存在", "en-US": "Tool version not found" }, traceId: req.ctx.traceId });
    return { version: ver };
  });

  app.post("/tools/:toolRef/execute", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    /* ── Phase 1: Resolve & validate tool via execution kernel ── */
    const resolved = await resolveAndValidateTool({
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, rawToolRef: params.toolRef,
    });
    const ver = resolved.version;
    const toolRef = resolved.toolRef;
    const toolName = resolved.toolName;

    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      null;

    setAuditContext(req, { resourceType: "tool", action: "execute", toolRef, idempotencyKey: idempotencyKey ?? undefined });
    const decision = await requirePermission({ req, resourceType: "tool", action: "execute" });
    req.ctx.audit!.policyDecision = decision;

    if (!["entity.create", "entity.update", "entity.delete", "memory.read", "memory.write", "knowledge.search"].includes(toolName)) {
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

    let scGate: any = null;
    if (ver.artifactRef) {
      const policy = resolveSupplyChainPolicy();
      const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
      const envRunnerOk = override ? isValidUrl(override) : false;
      const dbRunner = policy.minIsolation === "remote" && !envRunnerOk ? await getEnabledSkillRuntimeRunner({ pool: app.db as any, tenantId: subject.tenantId }) : null;
      const remoteRunnerOk = policy.minIsolation !== "remote" ? true : Boolean(envRunnerOk || dbRunner);
      const available: ("process" | "container" | "remote")[] = remoteRunnerOk ? ["process", "container", "remote"] : ["process", "container"];
      const gate = runSupplyChainGate({
        policy,
        trustSummary: (ver as any).trustSummary,
        scanSummary: (ver as any).scanSummary,
        sbomSummary: (ver as any).sbomSummary,
        sbomDigest: (ver as any).sbomDigest,
        requestedIsolation: "auto",
        availableRuntimes: available,
      });
      scGate = {
        trust: { required: gate.trust.enforced, status: gate.trust.status, ok: gate.trust.ok },
        scan: { required: gate.scan.enforced, mode: gate.scan.mode, status: gate.scan.status, ok: gate.scan.ok, vulnerabilities: gate.scan.vulnerabilities ?? null },
        sbom: { required: gate.sbom.enforced, mode: gate.sbom.mode, status: gate.sbom.status, ok: gate.sbom.ok, hasDigest: gate.sbom.hasDigest },
        isolation: { minIsolation: policy.minIsolation, remoteRunnerOk, ok: !gate.isolation.denied },
      };
      if (!gate.trust.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate: scGate };
        throw Errors.trustNotVerified();
      }
      if (!gate.scan.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate: scGate };
        throw Errors.scanNotPassed();
      }
      if (!gate.sbom.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate: scGate };
        throw Errors.sbomNotPresent();
      }
      if (gate.isolation.denied) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { supplyChainGate: scGate };
        throw Errors.isolationRequired();
      }
    }

    const body = req.body as any;
    let input = body;
    let limits: any = null;
    let capabilityEnvelope: any = null;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      limits = body.limits ?? null;
      capabilityEnvelope = body.capabilityEnvelope ?? null;
      input = { ...body };
      delete (input as any).limits;
      delete (input as any).networkPolicy;
      delete (input as any).capabilityEnvelope;
    }

    const injEff = await getEffectiveSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, policyType: "injection" });
    const piPolicy = injEff?.policyJson ? resolvePromptInjectionPolicy(injEff.policyJson as any) : getPromptInjectionPolicyFromEnv();
    const piMode = piPolicy.mode;
    const piTarget = "tool:execute";
    const piText = extractTextForPromptInjectionScan(input);
    const piScan = scanPromptInjection(piText);
    const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, policy: piPolicy, target: piTarget });
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
    if (piDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = {
        safetySummary: {
          decision: "denied",
          target: piTarget,
          ruleIds: piSummary.ruleIds,
          promptInjection: piSummary,
          ...(injEff?.policyDigest ? { policyRefsDigest: { injectionPolicyDigest: String(injEff.policyDigest) } } : {}),
        },
      };
      throw Errors.safetyPromptInjectionDenied();
    }

    validateToolInput(ver.inputSchema, input);

    /* ── Phase 2: Admit via execution kernel ── */
    const opDecision = await requirePermission({ req, resourceType: resolved.resourceType, action: resolved.action });

    if (resolved.scope === "write" && !idempotencyKey) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("缺少 idempotency-key");
    }

    const admitted = await admitAndBuildStepEnvelope({
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId,
      subjectId: subject.subjectId ?? null, resolved, opDecision,
      limits, requestedCapabilityEnvelope: capabilityEnvelope, requireRequestedEnvelope: true,
    });
    const effNetDigest = admitted.networkPolicyDigest;

    /* ── Phase 3: Submit via execution kernel ── */
    const stepInput = buildStepInputPayload({
      kind: "tool.execute", resolved, admitted,
      input, idempotencyKey,
      tenantId: subject.tenantId, spaceId: subject.spaceId,
      subjectId: subject.subjectId, traceId: req.ctx.traceId,
    });

    const result = await submitNewToolRun({
      pool: app.db, queue: app.queue, tenantId: subject.tenantId,
      resolved, opDecision, stepInput,
      idempotencyKey, createdBySubjectId: subject.subjectId,
      trigger: "manual", masterKey: app.cfg.secrets.masterKey,
    });

    const receipt = {
      correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: result.runId, stepId: result.stepId },
      status: result.outcome as "queued" | "needs_approval",
    };

    if (result.outcome === "needs_approval") {
      req.ctx.audit!.outputDigest = {
        status: "needs_approval", approvalId: result.approvalId, toolRef,
        runId: result.runId, stepId: result.stepId,
        safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
        runtimePolicy: { networkPolicyDigest: effNetDigest },
        supplyChainGate: scGate,
      };
      return { jobId: result.jobId, runId: result.runId, stepId: result.stepId, approvalId: result.approvalId, receipt };
    }

    req.ctx.audit!.outputDigest = {
      status: "queued", toolRef,
      runId: result.runId, stepId: result.stepId,
      safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
      runtimePolicy: { networkPolicyDigest: effNetDigest },
      supplyChainGate: scGate,
    };
    return { jobId: result.jobId, runId: result.runId, stepId: result.stepId, receipt };
  });

  app.get("/tools/runs/:runId", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    const steps = await listSteps(app.db, run.runId);
    return { run, steps };
  });

  app.get("/tools/steps/:stepId", async (req, reply) => {
    const params = z.object({ stepId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "tool", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const res = await app.db.query(
      `
        SELECT s.*, r.tenant_id
        FROM steps s
        JOIN runs r ON r.run_id = s.run_id
        WHERE s.step_id = $1 AND r.tenant_id = $2 AND (s.input->>'spaceId') = $3
        LIMIT 1
      `,
      [params.stepId, subject.tenantId, subject.spaceId],
    );
    if (res.rowCount === 0) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Step 不存在", "en-US": "Step not found" }, traceId: req.ctx.traceId });
    const step = res.rows[0];
    return {
      step: {
        stepId: step.step_id,
        runId: step.run_id,
        seq: step.seq,
        status: step.status,
        attempt: step.attempt,
        toolRef: step.tool_ref,
        inputDigest: step.input_digest,
        outputDigest: step.output_digest,
        errorCategory: step.error_category,
        lastError: step.last_error,
        createdAt: step.created_at,
        updatedAt: step.updated_at,
      },
    };
  });
};
