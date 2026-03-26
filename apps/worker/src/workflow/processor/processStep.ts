import type { Pool } from "pg";
import { validateCapabilityEnvelopeV1, resolveSupplyChainPolicy, checkTrust, checkDependencyScan, checkSbom } from "@openslin/shared";
import { acquireWriteLease, releaseWriteLease } from "../writeLease";
import { writeAudit } from "./audit";
import { executeBuiltinTool } from "./builtinTools";
import { digestObject, isPlainObject, jsonByteLength, scrubBySchema, sha256Hex, stableStringify, validateBySchema } from "./common";
import { decryptStepInputIfNeeded, encryptStepOutputAndCompensation } from "./encryption";
import { createArtifact } from "./entity";
import { executeDynamicSkill } from "./dynamicSkill";
import { handleEntityExportJob, handleEntityImportJob, handleSchemaMigrationJob, handleSpaceBackupJob, handleSpaceRestoreJob } from "./jobHandlers";
import type { EgressEvent } from "./runtime";
import { normalizeLimits, normalizeNetworkPolicy, withConcurrency, withTimeout } from "./runtime";
import { computeEvidenceDigestV1, computeSealedDigestV1, deriveIsolation } from "./sealed";
import { buildSafeToolOutput, computeWriteLeaseResourceRef, isWriteLeaseTool, loadToolVersion, parseToolRef } from "./tooling";
import { appendCollabEventOnce } from "../../lib/collabEvents";
// ── 拆分模块导入 ──
import { checkExecutionInvariants, isSideEffectWriteTool } from "./stepValidation";
import { validateStepTransition, validateRunTransition, sealRunIfFinished } from "./stepSealing";
import { extractErrorInfo, getErrorRecoveryDecision } from "./stepErrorClassifier";

// ── 辅助函数（保留原位置引用兼容）──
function isSideEffectWriteToolName(toolName: string) {
  return isSideEffectWriteTool(toolName);
}

export async function processStep(params: { pool: Pool; jobId: string; runId: string; stepId: string; masterKey?: string }) {
  const masterKey =
    String(params.masterKey ?? "").trim() ||
    String(process.env.API_MASTER_KEY ?? "").trim() ||
    (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  const stepRes = await params.pool.query("SELECT * FROM steps WHERE step_id = $1 LIMIT 1", [params.stepId]);
  if (stepRes.rowCount === 0) throw new Error("step_not_found");
  const step = stepRes.rows[0];

  const jobRes = await params.pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [params.jobId]);
  if (jobRes.rowCount === 0) throw new Error("job_not_found");
  const jobType = String(jobRes.rows[0].job_type ?? "");

  const runRes = await params.pool.query("SELECT * FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
  if (runRes.rowCount === 0) throw new Error("run_not_found");
  const run = runRes.rows[0];
  const tenantId = String(run.tenant_id ?? "");
  const isComp = String(run.trigger ?? "") === "compensate";

  async function updateCompensationStatus(status: string) {
    if (!isComp || !tenantId) return;
    await params.pool.query("UPDATE workflow_step_compensations SET status = $3, updated_at = now() WHERE tenant_id = $1 AND compensation_run_id = $2", [
      tenantId,
      params.runId,
      status,
    ]);
  }

  const runStatus = String(run.status ?? "");
  const stepStatus = String(step.status ?? "");
  if (runStatus === "needs_approval") {
    validateStepTransition(params.stepId, stepStatus, "pending");
    await params.pool.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
    await params.pool.query("UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1 AND status <> 'succeeded'", [params.stepId]);
    return;
  }

  if (runStatus === "needs_arbiter") {
    validateStepTransition(params.stepId, stepStatus, "pending");
    await params.pool.query("UPDATE jobs SET status = 'needs_arbiter', updated_at = now() WHERE job_id = $1", [params.jobId]);
    await params.pool.query("UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1 AND status <> 'succeeded'", [params.stepId]);
    return;
  }

  if (runStatus === "needs_device") {
    validateStepTransition(params.stepId, stepStatus, "pending");
    await params.pool.query("UPDATE jobs SET status = 'needs_device', updated_at = now() WHERE job_id = $1", [params.jobId]);
    await params.pool.query("UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1 AND status <> 'succeeded'", [params.stepId]);
    return;
  }

  if (runStatus === "canceled") {
    validateStepTransition(params.stepId, stepStatus, "canceled");
    validateRunTransition(params.runId, runStatus, "canceled");
    await updateCompensationStatus("canceled");
    await params.pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1", [
      params.stepId,
    ]);
    await params.pool.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE job_id = $1", [params.jobId]);
    return;
  }

  const metaInput = step.input as any;
  const traceId = (metaInput?.traceId as string | undefined) ?? (metaInput?.trace_id as string | undefined) ?? "unknown";
  const toolRef = step.tool_ref as string | null;
  const seq = Number(step.seq ?? 0) || 0;
  const collabRunId = typeof metaInput?.collabRunId === "string" ? String(metaInput.collabRunId) : "";
  const taskId = typeof metaInput?.taskId === "string" ? String(metaInput.taskId) : "";
  const actorRole = typeof metaInput?.actorRole === "string" ? String(metaInput.actorRole) : null;
  const planStepId = typeof metaInput?.planStepId === "string" ? String(metaInput.planStepId) : null;
  const stepKind = typeof metaInput?.stepKind === "string" ? String(metaInput.stepKind) : null;
  const spaceIdFromMeta = metaInput?.spaceId ? String(metaInput.spaceId) : null;

  // ── P1-12: 架构不变式检查 ──
  const parsedForInv = toolRef ? parseToolRef(toolRef) : null;
  const isWriteToolForInv = String(metaInput?.toolContract?.scope ?? "") === "write"
    || (parsedForInv ? isSideEffectWriteToolName(parsedForInv.name) : false);
  checkExecutionInvariants({
    stepId: params.stepId,
    runId: params.runId,
    tenantId,
    toolRef,
    traceId,
    runStatus,
    stepStatus,
    isWriteTool: isWriteToolForInv,
    hasPolicySnapshotRef: !!run.policy_snapshot_ref,
  });

  if (jobType === "schema.migration") {
    const inputDigest = digestObject(metaInput);
    await handleSchemaMigrationJob({
      pool: params.pool,
      jobId: params.jobId,
      runId: params.runId,
      stepId: params.stepId,
      traceId,
      tenantId: String(run.tenant_id ?? ""),
      spaceId: spaceIdFromMeta,
      subjectId: typeof metaInput?.subjectId === "string" ? String(metaInput.subjectId) : null,
      inputDigest,
      input: metaInput,
    });
    return;
  }

  async function appendCollabEventOnceForStep(type: string, payloadDigest: any | null) {
    if (!collabRunId || !taskId) return;
    const tenantId = String(run.tenant_id ?? "");
    if (!tenantId) return;
    await appendCollabEventOnce({
      pool: params.pool,
      tenantId,
      spaceId: spaceIdFromMeta,
      collabRunId,
      taskId,
      type,
      actorRole,
      runId: params.runId,
      stepId: params.stepId,
      payloadDigest,
      dedupeKeys: ["stepId"],
    });
  }

  validateRunTransition(params.runId, runStatus, isComp ? "compensating" : "running");
  await params.pool.query("UPDATE runs SET status = $2, started_at = COALESCE(started_at, now()), updated_at = now() WHERE run_id = $1", [
    params.runId,
    isComp ? "compensating" : "running",
  ]);
  const limits = normalizeLimits(metaInput?.limits);
  const networkPolicy = normalizeNetworkPolicy(metaInput?.networkPolicy);
  const parsedForDigest = toolRef ? parseToolRef(toolRef) : null;
  const sideEffectWrite =
    String(metaInput?.toolContract?.scope ?? "") === "write" || (parsedForDigest ? isSideEffectWriteToolName(parsedForDigest.name) : false);
  const inputDigest = {
    toolRef,
    limits,
    networkPolicy,
    sideEffectWrite,
    inputKeys: digestObject(metaInput),
  };
  const sealedInputDigest = computeSealedDigestV1(inputDigest);
  validateStepTransition(params.stepId, stepStatus, isComp ? "running" : "running");
  await params.pool.query(
    "UPDATE steps SET status = $2, attempt = attempt + 1, input_digest = COALESCE(input_digest, $3), started_at = COALESCE(started_at, now()), updated_at = now() WHERE step_id = $1",
    [params.stepId, isComp ? "compensating" : "running", inputDigest],
  );
  if (jobType === "agent.run" && tenantId && spaceIdFromMeta) {
    const phase =
      stepKind === "retriever"
        ? "retrieving"
        : stepKind === "guard"
          ? "guarding"
          : stepKind === "reviewer"
            ? "reviewing"
            : stepKind === "executor"
              ? "executing"
              : null;
    if (phase) {
      await params.pool.query(
        "UPDATE memory_task_states SET phase = $4, step_id = $5, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
        [tenantId, spaceIdFromMeta, params.runId, phase, params.stepId],
      );
    }
  }
  await updateCompensationStatus("running");
  try {
    await appendCollabEventOnceForStep("collab.step.started", { toolRef, seq, planStepId });
  } catch (e: any) {
    console.warn("[processStep] collab.step.started event failed", { stepId: params.stepId, traceId: params.runId, error: String(e?.message ?? e) });
  }

  const egress: EgressEvent[] = [];
  let rawInput = metaInput as any;
  let capabilityEnvelope: any = null;
  try {
    if (!tenantId) throw new Error("missing_tenant_id");
    rawInput = await decryptStepInputIfNeeded({ pool: params.pool, tenantId, masterKey, step, metaInput });
    const spaceId = rawInput?.spaceId ?? null;
    const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
    const capRaw = rawInput?.capabilityEnvelope ?? metaInput?.capabilityEnvelope ?? null;
    if (jobType === "tool.execute" || jobType === "agent.run") {
      if (!capRaw) {
        const e: any = new Error("policy_violation:capability_envelope_missing");
        e.capabilityEnvelopeSummary = { status: "missing" };
        throw e;
      }
      const parsed = validateCapabilityEnvelopeV1(capRaw);
      if (!parsed.ok) {
        const e: any = new Error("policy_violation:capability_envelope_invalid");
        e.capabilityEnvelopeSummary = { status: "invalid" };
        throw e;
      }
      capabilityEnvelope = parsed.envelope;
      const tc = rawInput?.toolContract;
      if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
        const e: any = new Error("policy_violation:capability_envelope_mismatch:tool_contract_missing");
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["toolContract"] };
        throw e;
      }
      const spaceIdNorm = spaceId === null || spaceId === undefined ? null : String(spaceId);
      const subjectIdNorm = subjectId === null || subjectId === undefined ? null : String(subjectId);
      const expected = validateCapabilityEnvelopeV1({
        format: "capabilityEnvelope.v1",
        dataDomain: {
          tenantId,
          spaceId: spaceIdNorm,
          subjectId: subjectIdNorm,
          toolContract: {
            scope: String((tc as any).scope ?? ""),
            resourceType: String((tc as any).resourceType ?? ""),
            action: String((tc as any).action ?? ""),
            fieldRules: (tc as any).fieldRules ?? null,
            rowFilters: (tc as any).rowFilters ?? null,
          },
        },
        secretDomain: { connectorInstanceIds: [] },
        egressDomain: { networkPolicy },
        resourceDomain: { limits },
      });
      if (!expected.ok) {
        const e: any = new Error("policy_violation:capability_envelope_mismatch:expected_invalid");
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["expected"] };
        throw e;
      }
      const diffs: string[] = [];
      if (stableStringify(parsed.envelope.dataDomain) !== stableStringify(expected.envelope.dataDomain)) diffs.push("dataDomain");
      if (stableStringify(parsed.envelope.secretDomain) !== stableStringify(expected.envelope.secretDomain)) diffs.push("secretDomain");
      if (stableStringify(parsed.envelope.egressDomain) !== stableStringify(expected.envelope.egressDomain)) diffs.push("egressDomain");
      if (stableStringify(parsed.envelope.resourceDomain) !== stableStringify(expected.envelope.resourceDomain)) diffs.push("resourceDomain");
      if (diffs.length) {
        const e: any = new Error(`policy_violation:capability_envelope_mismatch:${diffs.join(",")}`);
        e.capabilityEnvelopeSummary = { status: "mismatch", diffs };
        throw e;
      }
    }

    if (jobType === "entity.export") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleEntityExportJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "entity.import") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      const idempotencyKey = (run.idempotency_key as string | null) ?? null;
      if (!idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
      await handleEntityImportJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        idempotencyKey,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "space.backup") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleSpaceBackupJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (jobType === "space.restore") {
      if (!spaceId) throw new Error("policy_violation:missing_space");
      await handleSpaceRestoreJob({
        pool: params.pool,
        jobId: params.jobId,
        runId: params.runId,
        stepId: params.stepId,
        traceId,
        tenantId,
        spaceId,
        subjectId,
        inputDigest,
        input: rawInput,
      });
      return;
    }

    if (!toolRef) throw new Error("missing_tool_ref");

    const parsed = parseToolRef(toolRef);
    if (!parsed) {
      const msg = `invalid_tool_ref:${toolRef}`;
      await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now() WHERE step_id = $1", [
        params.stepId,
        "policy_violation",
        msg,
      ]);
      await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
      await updateCompensationStatus("failed");
      await writeAudit(params.pool, { traceId, tenantId, spaceId, subjectId, runId: params.runId, stepId: params.stepId, toolRef, result: "error", inputDigest: digestObject(step.input), errorCategory: "policy_violation" });
      return;
    }

    const ver = await loadToolVersion(params.pool, tenantId, toolRef);
    if (!ver) {
      const msg = `tool_not_released:${toolRef}`;
      await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now() WHERE step_id = $1", [
        params.stepId,
        "policy_violation",
        msg,
      ]);
      await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
      await updateCompensationStatus("failed");
      await writeAudit(params.pool, { traceId, tenantId, spaceId, subjectId, runId: params.runId, stepId: params.stepId, toolRef, result: "error", inputDigest: digestObject(step.input), errorCategory: "policy_violation" });
      return;
    }

    const trustSummary = (ver as any).trust_summary ?? null;
    const scanSummary = (ver as any).scan_summary ?? null;

    const toolContract = rawInput?.toolContract ?? null;
    const fieldRules = toolContract?.fieldRules ?? null;
    const rowFilters = toolContract?.rowFilters ?? null;
    const idempotencyRequired = toolContract?.idempotencyRequired ?? ["entity.create", "entity.update", "entity.delete", "memory.write"].includes(parsed.name);
    let idempotencyKey = run.idempotency_key as string | null;
    if (jobType === "agent.run") {
      const ik = rawInput?.idempotencyKey;
      if (typeof ik === "string" && ik.trim()) idempotencyKey = ik;
    }
    const metaToolInput = metaInput && typeof metaInput === "object" && !Array.isArray(metaInput) ? (metaInput as any).input : undefined;
    const toolInput = (metaToolInput !== undefined ? metaToolInput : rawInput?.input) ?? {};

    if (idempotencyRequired && !idempotencyKey) throw new Error("policy_violation:missing_idempotency_key");
    const schemaName = toolInput?.schemaName ?? "core";

    const concurrencyKey = `${tenantId}:${toolRef}`;
    const startedAt = Date.now();

    let artifactRef: string | null = ver.artifact_ref ?? null;
    let depsDigest: string | null = ver.deps_digest ?? null;
    let runtimeBackend: string = artifactRef ? "process" : "builtin";
    let degraded = false;
    let runnerSummary: any = null;

    if (artifactRef) {
      const _policy = resolveSupplyChainPolicy();
      const _trust = checkTrust(_policy, trustSummary);
      if (!_trust.ok) throw new Error("policy_violation:trust_not_verified");
      const _scan = checkDependencyScan(_policy, scanSummary);
      if (!_scan.ok) throw new Error("policy_violation:scan_not_passed");
      const _sbom = checkSbom(_policy, (ver as any).sbom_summary, (ver as any).sbom_digest);
      if (!_sbom.ok) throw new Error("policy_violation:sbom_not_present");
    }

    const guardPlanSteps = (toolInput as any)?.plan?.steps;
    const guardPlanEmpty =
      parsed.name === "collab.guard" && stepKind === "guard" && Array.isArray(guardPlanSteps) && guardPlanSteps.length === 0;

    const output = guardPlanEmpty
      ? { allow: false, requiresApproval: false, blockedReasons: [{ code: "plan_empty" }], recommendedArbiterAction: "stop" }
      : await withConcurrency(concurrencyKey, limits.maxConcurrency, async () => {
      return withTimeout(limits.timeoutMs, async (signal) => {
        const withWriteLease = async <T>(toolName: string, fn: () => Promise<T>) => {
          if (!isWriteLeaseTool(toolName)) return fn();
          const resourceRef = computeWriteLeaseResourceRef({ toolName, spaceId, idempotencyKey, toolInput });
          if (!resourceRef) return fn();
          const owner = { runId: params.runId, stepId: params.stepId, traceId };
          const ttlMs = Math.max(60_000, limits.timeoutMs + 10_000);
          const leaseKeyDigest = sha256Hex(stableStringify({ tenantId, spaceId, resourceRef }));
          const ownerDigest = sha256Hex(stableStringify(owner));
          const acquired = await acquireWriteLease({ pool: params.pool, tenantId, spaceId: String(spaceId), resourceRef, owner, ttlMs });
          if (!acquired.acquired) {
            const expiresAtMs = Date.parse(acquired.expiresAt);
            const deltaMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - Date.now()) : 1_000;
            const backoffMs = Math.max(200, Math.min(5_000, Math.round(deltaMs + 50)));
            const currentOwnerDigest = sha256Hex(stableStringify(acquired.currentOwner));
            const e: any = new Error("write_lease_busy");
            e.writeLease = { leaseKeyDigest, ownerDigest, currentOwnerDigest, expiresAt: acquired.expiresAt, backoffMs };
            throw e;
          }
          try {
            return await fn();
          } finally {
            try {
              await releaseWriteLease({ pool: params.pool, tenantId, spaceId: String(spaceId), resourceRef, owner });
            } catch (e: any) {
              console.warn("[processStep] releaseWriteLease failed", { stepId: params.stepId, error: String(e?.message ?? e) });
            }
          }
        };

        if (artifactRef) {
          const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
          const dyn = await executeDynamicSkill({
            pool: params.pool,
            jobId: params.jobId,
            runId: params.runId,
            stepId: params.stepId,
            masterKey,
            capabilityEnvelope,
            toolRef,
            tenantId,
            spaceId,
            subjectId,
            traceId,
            idempotencyKey,
            input: toolInput,
            limits,
            networkPolicy,
            artifactRef,
            depsDigest,
            egress,
            signal,
          });
          depsDigest = dyn.depsDigest;
          runtimeBackend = dyn.runtimeBackend;
          degraded = dyn.degraded;
          runnerSummary = dyn.runnerSummary ?? null;
          return dyn.output;
        }
        return executeBuiltinTool({
          name: parsed.name,
          toolRef,
          pool: params.pool,
          tenantId,
          spaceId,
          subjectId,
          traceId,
          runId: params.runId,
          stepId: params.stepId,
          policySnapshotRef: typeof run.policy_snapshot_ref === "string" ? String(run.policy_snapshot_ref) : null,
          idempotencyKey,
          schemaName,
          toolInput,
          fieldRules,
          rowFilters,
          limits,
          networkPolicy,
          egress,
          signal,
          withWriteLease,
        });
      });
    });

    const scrubbedOutput = scrubBySchema(ver.output_schema, output);
    validateBySchema("output", ver.output_schema, scrubbedOutput);
    const outputBytes = jsonByteLength(scrubbedOutput);
    if (outputBytes > limits.maxOutputBytes) {
      throw new Error("resource_exhausted:max_output_bytes");
    }

    const latencyMs = Date.now() - startedAt;
    const artifactId = artifactRef && String(artifactRef).startsWith("artifact:") ? String(artifactRef).slice("artifact:".length).trim() : null;
    const isolation = deriveIsolation(runtimeBackend, degraded);
    const ev = parsed.name === "knowledge.search" ? computeEvidenceDigestV1(scrubbedOutput) : null;
    const egressDigest = { sha256_8: sha256Hex(stableStringify(egress)).slice(0, 8), count: egress.length };
    const outputDigest = {
      latencyMs,
      egressSummary: egress,
      egressCount: egress.length,
      egressDigest,
      limitsSnapshot: limits,
      networkPolicySnapshot: networkPolicy,
      depsDigest,
      artifactId,
      artifactRef,
      runtimeBackend,
      degraded,
      runnerSummary,
      isolation,
      retrievalLogId: ev ? (typeof (scrubbedOutput as any)?.retrievalLogId === "string" ? String((scrubbedOutput as any).retrievalLogId) : "") : "",
      evidenceCount: ev ? ev.evidenceCount : 0,
      evidenceDigest: ev ? ev.evidenceDigest : null,
      outputBytes,
      outputKeys: digestObject(scrubbedOutput),
    };
    const sealedOutputDigest = computeSealedDigestV1(outputDigest);
    const supplyChain = { depsDigest, artifactId, artifactRef, sbomDigest: (ver as any)?.sbom_digest ?? null, verified: true };

    const runStatusRes = await params.pool.query("SELECT status FROM runs WHERE run_id = $1 LIMIT 1", [params.runId]);
    const runStatus = runStatusRes.rowCount ? String(runStatusRes.rows[0].status ?? "") : "";
    if (runStatus === "canceled") {
      await params.pool.query(
        "UPDATE steps SET status = 'canceled', output_digest = $2, sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $3), sealed_output_digest = $4, nondeterminism_policy = COALESCE(nondeterminism_policy, $5), supply_chain = $6, isolation = $7, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
        [params.stepId, outputDigest, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }, supplyChain, isolation],
      );
      await params.pool.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE job_id = $1", [params.jobId]);
      await params.pool.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
      await sealRunIfFinished({ pool: params.pool, runId: params.runId });
      await updateCompensationStatus("canceled");
      return;
    }

    const safeOutput = buildSafeToolOutput(parsed.name, scrubbedOutput);
    const enc =
      spaceId && (jobType === "tool.execute" || jobType === "agent.run")
        ? await encryptStepOutputAndCompensation({
            pool: params.pool,
            tenantId,
            spaceId,
            masterKey,
            stepInputKeyVersion: step.input_key_version as number | null,
            jobType,
            toolName: parsed.name,
            schemaName,
            toolInput,
            scrubbedOutput,
            sideEffectWrite,
          })
        : {
            outputEncFormat: null,
            outputKeyVersion: null,
            outputEncryptedPayload: null,
            compensationEncFormat: null,
            compensationKeyVersion: null,
            compensationEncryptedPayload: null,
          };
    const outputEncFormat = enc.outputEncFormat;
    const outputKeyVersion = enc.outputKeyVersion;
    const outputEncryptedPayload = enc.outputEncryptedPayload;
    const compensationEncFormat = enc.compensationEncFormat;
    const compensationKeyVersion = enc.compensationKeyVersion;
    const compensationEncryptedPayload = enc.compensationEncryptedPayload;

    await params.pool.query(
      "UPDATE steps SET status = $2, output = $3, output_digest = $4, sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $5), sealed_output_digest = $6, nondeterminism_policy = COALESCE(nondeterminism_policy, $7), supply_chain = $8, isolation = $9, output_enc_format = $10, output_key_version = $11, output_encrypted_payload = $12, compensation_enc_format = $13, compensation_key_version = $14, compensation_encrypted_payload = $15, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
      [
        params.stepId,
        isComp ? "compensated" : "succeeded",
        safeOutput,
        outputDigest,
        sealedInputDigest,
        sealedOutputDigest,
        { ignoredJsonPaths: ["latencyMs"] },
        supplyChain,
        isolation,
        outputEncFormat,
        outputKeyVersion,
        outputEncryptedPayload,
        compensationEncFormat,
        compensationKeyVersion,
        compensationEncryptedPayload,
      ],
    );
    await updateCompensationStatus("succeeded");
    try {
      await appendCollabEventOnceForStep("collab.step.completed", { toolRef, seq, planStepId, outputDigest });
    } catch (e: any) {
      console.warn("[processStep] collab.step.completed event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
    }

    if (collabRunId && tenantId && taskId && planStepId) {
      try {
        await params.pool.query(
          `
            UPDATE collab_task_assignments
            SET status = 'succeeded',
                output_digest = COALESCE(output_digest, '{}'::jsonb) || $5::jsonb,
                updated_at = now()
            WHERE tenant_id = $1
              AND collab_run_id = $2
              AND task_id = $3
              AND (input_digest->>'planStepId') = $4
          `,
          [tenantId, collabRunId, taskId, planStepId, JSON.stringify({ stepId: params.stepId, toolRef, status: "succeeded" })],
        );
      } catch (e: any) {
        console.warn("[processStep] collab_task_assignments update failed", { stepId: params.stepId, error: String(e?.message ?? e) });
      }
      if (actorRole) {
        try {
          await params.pool.query(
            "UPDATE collab_agent_roles SET status = 'completed', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2 AND role_name = $3",
            [tenantId, collabRunId, actorRole],
          );
        } catch (e: any) {
          console.warn("[processStep] collab_agent_roles update failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
      }
    }

    if (jobType === "agent.run" && tenantId && spaceIdFromMeta) {
      const artifactsUpdate = async (patch: any) => {
        await params.pool.query(
          "UPDATE memory_task_states SET artifacts_digest = COALESCE(artifacts_digest, '{}'::jsonb) || $4::jsonb, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
          [tenantId, spaceIdFromMeta, params.runId, patch],
        );
      };

      if (parsed.name === "knowledge.search" && stepKind === "retriever" && taskId && spaceIdFromMeta) {
        const retrievalLogId = typeof scrubbedOutput?.retrievalLogId === "string" ? String(scrubbedOutput.retrievalLogId) : "";
        const evRes = retrievalLogId
          ? await params.pool.query("SELECT cited_refs FROM knowledge_retrieval_logs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1", [
              tenantId,
              spaceIdFromMeta,
              retrievalLogId,
            ])
          : { rowCount: 0, rows: [] as any[] };
        const evidenceRefs = evRes.rowCount ? (evRes.rows[0].cited_refs ?? []) : [];
        const evidenceCount = Array.isArray(evidenceRefs) ? evidenceRefs.length : 0;
        await artifactsUpdate({ collabRetrieval: { retrievalLogId: retrievalLogId || null, evidenceCount } });
        try {
          await appendCollabEventOnceForStep("collab.role.retriever.completed", { retrievalLogId: retrievalLogId || null, evidenceCount });
        } catch (e: any) {
          console.warn("[processStep] collab.role.retriever.completed event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
        const exMsg = await params.pool.query(
          "SELECT 1 FROM agent_messages WHERE tenant_id = $1 AND task_id = $2 AND (correlation->>'stepId') = $3 LIMIT 1",
          [tenantId, taskId, params.stepId],
        );
        if (!exMsg.rowCount) {
          await params.pool.query(
            "INSERT INTO agent_messages (tenant_id, space_id, task_id, from_agent_id, from_role, intent, correlation, inputs, outputs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              tenantId,
              spaceIdFromMeta,
              taskId,
              null,
              actorRole ?? "retriever",
              "retrieve",
              { collabRunId, runId: params.runId, stepId: params.stepId, planStepId },
              null,
              { retrievalLogId: retrievalLogId || null, evidenceRefs },
            ],
          );
        }
      }

      if (parsed.name === "collab.guard" && stepKind === "guard") {
        const stepsLen = (v: any) => {
          if (Array.isArray(v)) return v.length;
          if (typeof v === "string") {
            try {
              const j = JSON.parse(v);
              if (Array.isArray(j)) return j.length;
            } catch {
            }
          }
          return null;
        };
        const metaPlanStepsLen = stepsLen((metaInput as any)?.input?.plan?.steps);
        const toolPlanStepsLen = stepsLen((toolInput as any)?.plan?.steps);
        const planStepsLen = stepsLen((rawInput as any)?.input?.plan?.steps) ?? toolPlanStepsLen ?? metaPlanStepsLen;
        const recommendedStop = String((scrubbedOutput as any)?.recommendedArbiterAction ?? "") === "stop";
        const allow =
          recommendedStop || metaPlanStepsLen === 0 || toolPlanStepsLen === 0
            ? false
            : typeof scrubbedOutput?.allow === "boolean"
              ? Boolean(scrubbedOutput.allow)
              : planStepsLen !== null
                ? planStepsLen > 0
                : true;
        const requiresApproval = typeof scrubbedOutput?.requiresApproval === "boolean" ? Boolean(scrubbedOutput.requiresApproval) : false;
        const autoArbiter = Boolean(metaInput?.autoArbiter);
        await artifactsUpdate({ collabGuard: { allow, requiresApproval } });
        try {
          await appendCollabEventOnceForStep("collab.role.guard.completed", { allow, requiresApproval });
        } catch (e: any) {
          console.warn("[processStep] collab.role.guard.completed event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }

        if (!allow) {
          await params.pool.query("UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
          await params.pool.query("UPDATE jobs SET status = 'stopped', updated_at = now() WHERE job_id = $1", [params.jobId]);
          await params.pool.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status IN ('pending','running')", [
            params.runId,
          ]);
          if (collabRunId) {
            await params.pool.query("UPDATE collab_runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
            try {
              await appendCollabEventOnceForStep("collab.run.stopped", { reason: "guard_denied" });
            } catch (e: any) {
              console.warn("[processStep] collab.run.stopped event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
            }
          }
          await params.pool.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId, spaceIdFromMeta, params.runId, "stopped.guard_denied"],
          );
          await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef, result: "success", inputDigest, outputDigest });
          return;
        }

        if (requiresApproval) {
          const next = await params.pool.query(
            "SELECT step_id, tool_ref, policy_snapshot_ref, input_digest FROM steps WHERE run_id = $1 AND status = 'pending' AND (input->>'stepKind') = 'executor' ORDER BY seq ASC LIMIT 1",
            [params.runId],
          );
          const nextStepId = next.rowCount ? String(next.rows[0].step_id) : null;
          await params.pool.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE run_id = $1", [params.runId]);
          await params.pool.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE job_id = $1", [params.jobId]);
          if (collabRunId) await params.pool.query("UPDATE collab_runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
          if (spaceIdFromMeta && nextStepId && metaInput?.subjectId) {
            await params.pool.query(
              "INSERT INTO approvals (tenant_id, space_id, run_id, step_id, status, requested_by_subject_id, policy_snapshot_ref, input_digest) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7) ON CONFLICT (tenant_id, run_id) DO NOTHING",
              [
                tenantId,
                spaceIdFromMeta,
                params.runId,
                nextStepId,
                String(metaInput.subjectId),
                next.rowCount ? (next.rows[0].policy_snapshot_ref ?? null) : null,
                next.rowCount ? (next.rows[0].input_digest ?? null) : null,
              ],
            );
            const approvalRes = await params.pool.query("SELECT approval_id FROM approvals WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [tenantId, params.runId]);
            const approvalId = approvalRes.rowCount ? String(approvalRes.rows[0].approval_id) : null;
            try {
              await appendCollabEventOnceForStep("collab.run.needs_approval", { approvalId, stepId: nextStepId });
            } catch (e: any) {
              console.warn("[processStep] collab.run.needs_approval event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
            }
            await artifactsUpdate({ collabApproval: { approvalId } });
          }
          await params.pool.query(
            "UPDATE memory_task_states SET phase = $4, step_id = $5, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId, spaceIdFromMeta, params.runId, "needs_approval", nextStepId],
          );
          await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef, result: "success", inputDigest, outputDigest });
          return;
        }

        if (!autoArbiter) {
          await params.pool.query("UPDATE runs SET status = 'needs_arbiter', updated_at = now() WHERE run_id = $1", [params.runId]);
          await params.pool.query("UPDATE jobs SET status = 'needs_arbiter', updated_at = now() WHERE job_id = $1", [params.jobId]);
          if (collabRunId) await params.pool.query("UPDATE collab_runs SET status = 'needs_arbiter', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
          await params.pool.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId, spaceIdFromMeta, params.runId, "needs_arbiter"],
          );
          try {
            await appendCollabEventOnceForStep("collab.run.needs_arbiter", { reason: "guard_completed" });
          } catch (e: any) {
            console.warn("[processStep] collab.run.needs_arbiter event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
          }
          await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef, result: "success", inputDigest, outputDigest });
          return;
        }

        try {
          await appendCollabEventOnceForStep("collab.arbiter.decision", { actorRole: "arbiter", mode: "auto", correlationId: String(metaInput?.correlationId ?? ""), allow, requiresApproval });
        } catch (e: any) {
          console.warn("[processStep] collab.arbiter.decision event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
      }

      if (parsed.name === "collab.review" && stepKind === "reviewer" && taskId) {
        const tsRes = await params.pool.query("SELECT artifacts_digest FROM memory_task_states WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL LIMIT 1", [
          tenantId,
          spaceIdFromMeta,
          params.runId,
        ]);
        const artifacts = tsRes.rowCount ? (tsRes.rows[0].artifacts_digest ?? null) : null;
        const retrievalLogId = artifacts && typeof artifacts === "object" ? String((artifacts as any)?.collabRetrieval?.retrievalLogId ?? "") : "";
        const evRes = retrievalLogId
          ? await params.pool.query("SELECT cited_refs FROM knowledge_retrieval_logs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1", [
              tenantId,
              spaceIdFromMeta,
              retrievalLogId,
            ])
          : { rowCount: 0, rows: [] as any[] };
        const evidenceRefs = evRes.rowCount ? (evRes.rows[0].cited_refs ?? []) : [];
        const citationsCount = Array.isArray(evidenceRefs) ? evidenceRefs.length : 0;
        const exMsg = await params.pool.query(
          "SELECT 1 FROM agent_messages WHERE tenant_id = $1 AND task_id = $2 AND (correlation->>'stepId') = $3 LIMIT 1",
          [tenantId, taskId, params.stepId],
        );
        if (!exMsg.rowCount) {
          await params.pool.query(
            "INSERT INTO agent_messages (tenant_id, space_id, task_id, from_agent_id, from_role, intent, correlation, inputs, outputs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              tenantId,
              spaceIdFromMeta,
              taskId,
              null,
              actorRole ?? "reviewer",
              "respond",
              { collabRunId, runId: params.runId, stepId: params.stepId, planStepId },
              { retrievalLogId: retrievalLogId || null, evidenceRefs },
              { finalAnswer: String(scrubbedOutput?.finalAnswer ?? ""), evidenceRefs, retrievalLogId: retrievalLogId || null },
            ],
          );
        }
        await artifactsUpdate({ collabReview: { citationsCount } });
        try {
          await appendCollabEventOnceForStep("collab.role.reviewer.completed", { citationsCount });
        } catch (e: any) {
          console.warn("[processStep] collab.role.reviewer.completed event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
      }
    }

    if (jobType === "agent.run") {
      const aggRes = await params.pool.query(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status IN ('pending','running'))::int AS remaining
          FROM steps
          WHERE run_id = $1
        `,
        [params.runId],
      );
      const total = Number(aggRes.rowCount ? aggRes.rows[0].total : 1) || 1;
      const succeeded = Number(aggRes.rowCount ? aggRes.rows[0].succeeded : 0) || 0;
      const remaining = Number(aggRes.rowCount ? aggRes.rows[0].remaining : 0) || 0;
      const progress = Math.max(0, Math.min(100, Math.round((succeeded / total) * 100)));
      if (remaining > 0) {
        await params.pool.query("UPDATE runs SET status = 'queued', updated_at = now(), finished_at = NULL WHERE run_id = $1", [params.runId]);
        await params.pool.query("UPDATE jobs SET status = 'queued', progress = $2, updated_at = now(), result_summary = $3 WHERE job_id = $1", [
          params.jobId,
          progress,
          safeOutput,
        ]);
      } else {
        await params.pool.query("UPDATE runs SET status = $2, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [
          params.runId,
          isComp ? "compensated" : "succeeded",
        ]);
        await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, safeOutput]);
        if (tenantId && spaceIdFromMeta) {
          await params.pool.query(
            "UPDATE memory_task_states SET phase = $4, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
            [tenantId, spaceIdFromMeta, params.runId, isComp ? "compensated" : "succeeded"],
          );
        }
        await sealRunIfFinished({ pool: params.pool, runId: params.runId });
      }
    } else {
      await params.pool.query("UPDATE runs SET status = $2, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [
        params.runId,
        isComp ? "compensated" : "succeeded",
      ]);
      await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, safeOutput]);
      await sealRunIfFinished({ pool: params.pool, runId: params.runId });
    }

    await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef, result: "success", inputDigest, outputDigest });
  } catch (err: any) {
    const rawMsg = String(err?.message ?? err);
    const msg = rawMsg.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : rawMsg;
    const category =
      msg === "timeout"
        ? "timeout"
        : msg === "needs_device"
          ? "needs_device"
          : msg.startsWith("resource_exhausted:")
            ? "resource_exhausted"
            : msg.startsWith("policy_violation:")
              ? "policy_violation"
              : msg.startsWith("output_schema:") || msg.startsWith("input_schema:")
                ? "internal"
                : msg === "write_lease_busy"
                  ? "retryable"
                  : msg.startsWith("conflict_")
                    ? "retryable"
                    : msg.startsWith("schema_not_found:")
                      ? "retryable"
                      : msg.startsWith("device_execution_failed:")
                        ? "device_execution_failed"
                        : "retryable";

    /* ── 设备执行挂起：参考 needs_approval 模式，不标记 step 为 failed ── */
    if (category === "needs_device") {
      const deviceExecutionId = (err as any)?.deviceExecutionId ?? null;
      const deviceId = (err as any)?.deviceId ?? null;
      await params.pool.query("UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1", [params.stepId]);
      await params.pool.query("UPDATE runs SET status = 'needs_device', updated_at = now() WHERE run_id = $1", [params.runId]);
      await params.pool.query("UPDATE jobs SET status = 'needs_device', updated_at = now() WHERE job_id = $1", [params.jobId]);
      if (tenantId && spaceIdFromMeta) {
        await params.pool.query(
          "UPDATE memory_task_states SET phase = $4, step_id = $5, updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
          [tenantId, spaceIdFromMeta, params.runId, "needs_device", params.stepId],
        );
      }
      if (collabRunId) {
        await params.pool.query("UPDATE collab_runs SET status = 'needs_device', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [tenantId, collabRunId]);
        try {
          await appendCollabEventOnceForStep("collab.run.needs_device", { deviceExecutionId, deviceId, stepId: params.stepId, toolRef });
        } catch (e: any) {
          console.warn("[processStep] collab.run.needs_device event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
      }
      console.log(`[processStep] needs_device: runId=${params.runId} stepId=${params.stepId} deviceExecutionId=${deviceExecutionId} deviceId=${deviceId}`);
      await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef: toolRef ?? undefined, result: "success", inputDigest, outputDigest: { status: "needs_device", deviceExecutionId, deviceId } });
      return;
    }
    const outputDigest = {
      latencyMs: null,
      egressSummary: egress,
      egressCount: egress.length,
      limitsSnapshot: limits,
      networkPolicySnapshot: networkPolicy,
      depsDigest: null,
      artifactRef: null,
      error: msg,
      capabilityEnvelopeSummary: isPlainObject((err as any)?.capabilityEnvelopeSummary) ? (err as any).capabilityEnvelopeSummary : null,
      writeLease: isPlainObject(err?.writeLease) ? err.writeLease : null,
    };
    const sealedOutputDigest = computeSealedDigestV1(outputDigest);
    const isolation = deriveIsolation(null, false);
    const supplyChain = { depsDigest: null, artifactId: null, artifactRef: null, sbomDigest: null, verified: false };
    await params.pool.query("UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1", [
      params.stepId,
      category,
      msg,
    ]);
    await params.pool.query(
      "UPDATE steps SET sealed_at = COALESCE(sealed_at, now()), sealed_schema_version = COALESCE(sealed_schema_version, 1), sealed_input_digest = COALESCE(sealed_input_digest, $2), sealed_output_digest = COALESCE(sealed_output_digest, $3), nondeterminism_policy = COALESCE(nondeterminism_policy, $4), supply_chain = COALESCE(supply_chain, $5), isolation = COALESCE(isolation, $6), updated_at = now() WHERE step_id = $1",
      [params.stepId, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }, supplyChain, isolation],
    );
    try {
      await appendCollabEventOnceForStep("collab.step.failed", { toolRef, seq, planStepId, errorCategory: category });
    } catch (e: any) {
      console.warn("[processStep] collab.step.failed event failed", { stepId: params.stepId, error: String(e?.message ?? e) });
    }
    if (collabRunId && tenantId && taskId && planStepId) {
      try {
        await params.pool.query(
          `
            UPDATE collab_task_assignments
            SET status = 'failed',
                output_digest = COALESCE(output_digest, '{}'::jsonb) || $5::jsonb,
                updated_at = now()
            WHERE tenant_id = $1
              AND collab_run_id = $2
              AND task_id = $3
              AND (input_digest->>'planStepId') = $4
          `,
          [tenantId, collabRunId, taskId, planStepId, JSON.stringify({ stepId: params.stepId, toolRef, status: "failed", errorCategory: category })],
        );
      } catch (e: any) {
        console.warn("[processStep] collab_task_assignments update failed", { stepId: params.stepId, error: String(e?.message ?? e) });
      }
      if (actorRole) {
        try {
          await params.pool.query(
            "UPDATE collab_agent_roles SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2 AND role_name = $3",
            [tenantId, collabRunId, actorRole],
          );
        } catch (e: any) {
          console.warn("[processStep] collab_agent_roles update failed", { stepId: params.stepId, error: String(e?.message ?? e) });
        }
      }
    }
    await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now() WHERE run_id = $1", [params.runId]);
    await params.pool.query("UPDATE jobs SET status = 'failed', updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, { error: msg }]);
    await sealRunIfFinished({ pool: params.pool, runId: params.runId });
    await updateCompensationStatus("failed");

    try {
      const tenantId = run.tenant_id as string;
      const spaceId = rawInput?.spaceId ?? null;
      const subjectId = rawInput?.subjectId ? String(rawInput?.subjectId) : null;
      if (jobType === "space.backup" && tenantId && spaceId) {
        const reportText = JSON.stringify({ error: msg, traceId });
        const report = await createArtifact({
          pool: params.pool,
          tenantId,
          spaceId,
          type: "backup_report",
          format: "json",
          contentType: "application/json; charset=utf-8",
          contentText: reportText,
          source: { spaceId, traceId },
          runId: params.runId,
          stepId: params.stepId,
          createdBySubjectId: subjectId,
        });
        await params.pool.query("UPDATE backups SET status = 'failed', report_artifact_id = $3, updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [
          tenantId,
          params.runId,
          report.artifactId,
        ]);
      }
    } catch (e: any) {
      console.warn("[processStep] backup report creation failed", { stepId: params.stepId, error: String(e?.message ?? e) });
    }

    await writeAudit(params.pool, { traceId, runId: params.runId, stepId: params.stepId, toolRef: toolRef ?? undefined, result: "error", inputDigest, outputDigest, errorCategory: category });
    if (category === "policy_violation" || category === "internal") return;
    throw err;
  }
}
