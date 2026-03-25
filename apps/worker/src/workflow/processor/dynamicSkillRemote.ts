import crypto from "node:crypto";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";
import { sha256Hex, stableStringify } from "./common";
import { signRunnerRequestV1, verifyRunnerResponseSignatureV1 } from "./runnerProtocol";
import type { RunnerExecuteRequestV1, RunnerExecuteResponseV1 } from "./runnerProtocol";

function buildRunnerExecuteUrl(endpoint: string) {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("policy_violation:remote_runtime_endpoint_invalid");
  }
  const p = u.pathname || "/";
  if (p.endsWith("/v1/execute") || p === "/v1/execute") return u.toString();
  if (p === "/" || p === "") {
    u.pathname = "/v1/execute";
    return u.toString();
  }
  if (p.endsWith("/")) u.pathname = `${p}v1/execute`;
  else u.pathname = `${p}/v1/execute`;
  return u.toString();
}

function workerSigningKey() {
  const keyId = String(process.env.SKILL_RUNTIME_SIGNING_KEY_ID ?? "").trim();
  const privateKeyPem = String(process.env.SKILL_RUNTIME_SIGNING_PRIVATE_KEY_PEM ?? "").trim();
  if (!keyId || !privateKeyPem) return null;
  return { keyId, privateKeyPem };
}

function shouldVerifyRunnerSignature() {
  const raw = String(process.env.SKILL_RUNTIME_VERIFY_RUNNER_SIGNATURE ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return process.env.NODE_ENV === "production";
}

export async function executeDynamicSkillRemote(params: {
  endpoint: string;
  bearerToken: string | null;
  jobId: string;
  runId: string;
  stepId: string;
  requestId: string;
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  capabilityEnvelope: CapabilityEnvelopeV1;
  artifactRef: string;
  depsDigest: string;
  trustedKeys: Map<string, crypto.KeyObject>;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (params.bearerToken) headers.authorization = `Bearer ${params.bearerToken}`;
  headers["x-trace-id"] = params.traceId;
  if (params.idempotencyKey) headers["idempotency-key"] = params.idempotencyKey;

  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Math.max(30_000, params.limits.timeoutMs + 10_000)).toISOString();
  const inputStable = stableStringify(params.input);
  const inputSha = sha256Hex(inputStable);
  const inputBytes = Buffer.byteLength(inputStable, "utf8");
  const reqObj: RunnerExecuteRequestV1 = {
    format: "runner.execute.v1",
    requestId: params.requestId,
    issuedAt,
    expiresAt,
    scope: { tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId },
    jobRef: { jobId: params.jobId, runId: params.runId, stepId: params.stepId },
    toolRef: params.toolRef,
    artifactRef: params.artifactRef,
    depsDigest: params.depsDigest,
    input: params.input,
    inputDigest: { sha256: `sha256:${inputSha}`, sha256_8: inputSha.slice(0, 8), bytes: inputBytes },
    capabilityEnvelope: params.capabilityEnvelope,
    policyDigests: { networkPolicySha256_8: sha256Hex(stableStringify(params.capabilityEnvelope.egressDomain.networkPolicy)).slice(0, 8) },
  };
  const sk = workerSigningKey();
  if (sk) reqObj.signature = signRunnerRequestV1({ req: reqObj, keyId: sk.keyId, privateKeyPem: sk.privateKeyPem });

  let res: Response;
  const url = buildRunnerExecuteUrl(params.endpoint);
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqObj), signal: params.signal } as any);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? "remote_runtime_error");
    throw new Error(`policy_violation:remote_runtime_failed:${msg}`);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) {
      const legacyPayload = {
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: params.depsDigest,
      };
      let legacyRes: Response;
      try {
        legacyRes = await fetch(params.endpoint, { method: "POST", headers, body: JSON.stringify(legacyPayload), signal: params.signal } as any);
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? "remote_runtime_error");
        throw new Error(`policy_violation:remote_runtime_failed:${msg}`);
      }
      const legacyText = await legacyRes.text();
      if (!legacyRes.ok) throw new Error(`policy_violation:remote_runtime_http_${legacyRes.status}`);
      let legacyParsed: any;
      try {
        legacyParsed = legacyText ? JSON.parse(legacyText) : null;
      } catch {
        throw new Error("policy_violation:remote_runtime_bad_output");
      }
      if (!legacyParsed || typeof legacyParsed !== "object") throw new Error("policy_violation:remote_runtime_bad_output");
      if (legacyParsed.ok === false) throw new Error(String(legacyParsed?.error?.message ?? "skill_sandbox_error"));
      return {
        output: legacyParsed.output,
        egress: Array.isArray(legacyParsed.egress) ? legacyParsed.egress : [],
        depsDigest: String(legacyParsed.depsDigest ?? params.depsDigest),
        runtimeBackend: "remote",
        degraded: false,
      };
    }
    let err: any = null;
    try {
      err = text ? JSON.parse(text) : null;
    } catch {}
    const code = err && typeof err === "object" ? String(err.errorCode ?? "") : "";
    if (res.status === 403 && code === "TRUST_NOT_VERIFIED") throw new Error("policy_violation:trust_not_verified");
    if (res.status === 401) throw new Error("policy_violation:remote_runner_unauthorized");
    throw new Error(`policy_violation:remote_runtime_http_${res.status}`);
  }
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("policy_violation:remote_runtime_bad_output");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("policy_violation:remote_runtime_bad_output");
  if (parsed.format !== "runner.execute.v1") {
    if (typeof (parsed as any).ok === "boolean") {
      if ((parsed as any).ok === false) throw new Error(String((parsed as any)?.error?.message ?? "skill_sandbox_error"));
      return {
        output: (parsed as any).output,
        egress: Array.isArray((parsed as any).egress) ? ((parsed as any).egress as any[]) : [],
        depsDigest: String((parsed as any).depsDigest ?? params.depsDigest),
        runtimeBackend: "remote",
        degraded: false,
      };
    }
    throw new Error("policy_violation:runner_contract_violation:format");
  }
  const rr = parsed as RunnerExecuteResponseV1;
  if (rr.requestId !== params.requestId) throw new Error("policy_violation:runner_contract_violation:request_id");
  if (!rr.egressSummary || !rr.resourceUsageSummary) throw new Error("policy_violation:runner_contract_violation:missing_summaries");
  if (shouldVerifyRunnerSignature()) {
    const v = verifyRunnerResponseSignatureV1({ res: rr, trustedKeys: params.trustedKeys });
    if (!v.ok) throw new Error("policy_violation:trust_not_verified");
  }
  if (rr.status === "failed") {
    const cat = String(rr.errorCategory ?? "");
    const code = String(rr.errorCode ?? "");
    if (cat === "timeout" || code === "TIMEOUT") throw new Error("timeout");
    if (cat === "resource_exhausted" || code === "RESOURCE_EXHAUSTED") throw new Error("resource_exhausted:remote_runtime");
    if (code === "TRUST_NOT_VERIFIED") throw new Error("policy_violation:trust_not_verified");
    if (cat === "policy_violation") throw new Error("policy_violation:remote_runtime_policy_violation");
    throw new Error("remote_runtime_failed");
  }

  return {
    output: rr.output,
    egress: Array.isArray(rr.egressEvents) ? (rr.egressEvents as any[]) : [],
    depsDigest: String(params.depsDigest),
    runtimeBackend: "remote",
    degraded: false,
    runnerSummary: {
      requestId: rr.requestId,
      runnerSignature: rr.runnerSignature ? { keyId: rr.runnerSignature.keyId, digest8: String(rr.runnerSignature.signedDigest ?? "").slice(-8) } : null,
      egressSummary: rr.egressSummary,
      resourceUsageSummary: rr.resourceUsageSummary,
    },
  };
}
