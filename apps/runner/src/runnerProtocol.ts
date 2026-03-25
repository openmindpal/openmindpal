import crypto from "node:crypto";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { sha256Hex, stableStringify } from "./common";

export type RunnerErrorCode =
  | "TRUST_NOT_VERIFIED"
  | "RUNNER_CONTRACT_VIOLATION"
  | "RUNNER_UNAVAILABLE"
  | "REMOTE_RUNTIME_NOT_CONFIGURED"
  | "RESOURCE_EXHAUSTED"
  | "POLICY_VIOLATION"
  | "TIMEOUT"
  | "INTERNAL";

export type RunnerErrorCategory = "policy_violation" | "timeout" | "resource_exhausted" | "internal";

export type RunnerEgressSummaryV1 = {
  allowed: number;
  denied: number;
};

export type RunnerResourceUsageSummaryV1 = {
  latencyMs: number;
  outputBytes: number;
  egressRequests: number;
};

export type RunnerExecuteRequestV1 = {
  format: "runner.execute.v1";
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  scope: { tenantId: string; spaceId: string | null; subjectId: string | null };
  jobRef: { jobId: string; runId: string; stepId: string };
  toolRef: string;
  artifactRef: string | null;
  depsDigest: string | null;
  input: any;
  inputDigest: { sha256: string; sha256_8: string; bytes: number };
  capabilityEnvelope: CapabilityEnvelopeV1;
  policyDigests: { networkPolicySha256_8: string };
  signature?: { alg: "ed25519"; keyId: string; signedDigest: string; sigBase64: string };
};

export type RunnerExecuteResponseV1 = {
  format: "runner.execute.v1";
  requestId: string;
  status: "succeeded" | "failed";
  errorCode: RunnerErrorCode | null;
  errorCategory: RunnerErrorCategory | null;
  output: any;
  outputDigest: { sha256: string; sha256_8: string; bytes: number };
  egressSummary: RunnerEgressSummaryV1;
  egressEvents?: any[];
  resourceUsageSummary: RunnerResourceUsageSummaryV1;
  runnerSignature?: { alg: "ed25519"; keyId: string; signedDigest: string; sigBase64: string };
};

export function computeRunnerRequestBodyDigestV1(req: RunnerExecuteRequestV1) {
  const body = {
    format: req.format,
    requestId: req.requestId,
    issuedAt: req.issuedAt,
    expiresAt: req.expiresAt,
    scope: req.scope,
    jobRef: req.jobRef,
    toolRef: req.toolRef,
    artifactRef: req.artifactRef,
    depsDigest: req.depsDigest,
    inputDigest: req.inputDigest,
    capabilityEnvelope: req.capabilityEnvelope,
    policyDigests: req.policyDigests,
  };
  return `sha256:${sha256Hex(stableStringify(body))}`;
}

export function verifyRunnerRequestSignatureV1(params: {
  req: RunnerExecuteRequestV1;
  trustedKeys: Map<string, crypto.KeyObject>;
}): { ok: true } | { ok: false; error: string } {
  const sig = params.req.signature;
  if (!sig) return { ok: false, error: "missing_signature" };
  if (sig.alg !== "ed25519") return { ok: false, error: "unsupported_alg" };
  const pub = params.trustedKeys.get(sig.keyId);
  if (!pub) return { ok: false, error: "unknown_key" };
  const expected = computeRunnerRequestBodyDigestV1(params.req);
  if (sig.signedDigest !== expected) return { ok: false, error: "signed_digest_mismatch" };
  const msg = `openslin:runner:execute:${expected}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sig.sigBase64, "base64"));
  if (!ok) return { ok: false, error: "bad_signature" };
  return { ok: true };
}

export function computeRunnerResponseBodyDigestV1(res: RunnerExecuteResponseV1) {
  const body = {
    format: res.format,
    requestId: res.requestId,
    status: res.status,
    errorCode: res.errorCode,
    errorCategory: res.errorCategory,
    outputDigest: res.outputDigest,
    egressSummary: res.egressSummary,
    resourceUsageSummary: res.resourceUsageSummary,
  };
  return `sha256:${sha256Hex(stableStringify(body))}`;
}

export function signRunnerResponseV1(params: { res: RunnerExecuteResponseV1; keyId: string; privateKeyPem: string }) {
  const signedDigest = computeRunnerResponseBodyDigestV1(params.res);
  const msg = `openslin:runner:result:${signedDigest}`;
  const sig = crypto.sign(null, Buffer.from(msg, "utf8"), crypto.createPrivateKey(params.privateKeyPem));
  return { alg: "ed25519" as const, keyId: params.keyId, signedDigest, sigBase64: sig.toString("base64") };
}

export function loadTrustedWorkerKeysFromEnv(): Map<string, crypto.KeyObject> {
  const out = new Map<string, crypto.KeyObject>();
  const raw = String(process.env.RUNNER_TRUSTED_WORKER_KEYS_JSON ?? "").trim();
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries<any>(obj)) {
          const keyId = String(k ?? "").trim();
          const pem = typeof v === "string" ? v.trim() : "";
          if (!keyId || !pem) continue;
          try {
            out.set(keyId, crypto.createPublicKey(pem));
          } catch {}
        }
      }
    } catch {}
  }
  const keyId = String(process.env.RUNNER_TRUSTED_WORKER_KEY_ID ?? "").trim();
  const pem = String(process.env.RUNNER_TRUSTED_WORKER_PUBLIC_KEY_PEM ?? "").trim();
  if (keyId && pem) {
    try {
      out.set(keyId, crypto.createPublicKey(pem));
    } catch {}
  }
  return out;
}
