import crypto from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { jsonByteLength, sha256Hex, stableStringify } from "./common";
import type { NetworkPolicy } from "./runtime";
import { pushEgressAudit, setEgressAuditSink } from "./runtime";
import { executeSkillInSandbox } from "./executeSkill";
import { computeRunnerRequestBodyDigestV1, loadTrustedWorkerKeysFromEnv, signRunnerResponseV1, verifyRunnerRequestSignatureV1 } from "./runnerProtocol";
import type { RunnerExecuteRequestV1, RunnerExecuteResponseV1 } from "./runnerProtocol";

function nowIso() {
  return new Date().toISOString();
}

function requireBearerToken() {
  const raw = String(process.env.RUNNER_BEARER_TOKEN ?? "").trim();
  return raw || null;
}

function requireSignature() {
  const raw = String(process.env.RUNNER_REQUIRE_SIGNATURE ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV === "production";
}

function runnerSigningKey() {
  const keyId = String(process.env.RUNNER_SIGNING_KEY_ID ?? "").trim();
  const privateKeyPem = String(process.env.RUNNER_SIGNING_PRIVATE_KEY_PEM ?? "").trim();
  if (!keyId || !privateKeyPem) return null;
  return { keyId, privateKeyPem };
}

function networkPolicyDigest8(policy: any) {
  return sha256Hex(stableStringify(policy)).slice(0, 8);
}

const concurrencyCounters = new Map<string, number>();
const runnerMetrics = {
  executeTotal: 0,
  executeSucceeded: 0,
  executeFailed: 0,
  executeRejected: 0,
  egressAllowed: 0,
  egressDenied: 0,
  failuresByErrorCode: new Map<string, number>(),
};

function incMap(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

async function withConcurrency<T>(key: string, maxConcurrency: number, fn: () => Promise<T>) {
  const cur = concurrencyCounters.get(key) ?? 0;
  if (cur >= maxConcurrency) throw new Error("resource_exhausted:max_concurrency");
  concurrencyCounters.set(key, cur + 1);
  try {
    return await fn();
  } finally {
    const after = (concurrencyCounters.get(key) ?? 1) - 1;
    if (after <= 0) concurrencyCounters.delete(key);
    else concurrencyCounters.set(key, after);
  }
}

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function classifyError(rawMsg: string) {
  const msg = rawMsg.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : rawMsg;
  if (msg === "timeout") return { errorCategory: "timeout" as const, errorCode: "TIMEOUT" as const, message: msg };
  if (msg.startsWith("resource_exhausted:")) return { errorCategory: "resource_exhausted" as const, errorCode: "RESOURCE_EXHAUSTED" as const, message: msg };
  if (msg.startsWith("policy_violation:")) return { errorCategory: "policy_violation" as const, errorCode: "POLICY_VIOLATION" as const, message: msg };
  return { errorCategory: "internal" as const, errorCode: "INTERNAL" as const, message: msg };
}

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => {
    return {
      ok: true,
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage.rss() / 1048576),
      executeTotal: runnerMetrics.executeTotal,
      activeConcurrency: Array.from(concurrencyCounters.values()).reduce((a, b) => a + b, 0),
    };
  });

  app.get("/v1/capabilities", async () => {
    return {
      runner: {
        version: "v1",
        backends: ["remote"],
        supportsNetworkPolicyRules: true,
        supportsEd25519Signatures: true,
        supportsSandbox: true,
      },
    };
  });

  app.get("/v1/metrics", async () => {
    return {
      executeTotal: runnerMetrics.executeTotal,
      executeSucceeded: runnerMetrics.executeSucceeded,
      executeFailed: runnerMetrics.executeFailed,
      executeRejected: runnerMetrics.executeRejected,
      egressAllowed: runnerMetrics.egressAllowed,
      egressDenied: runnerMetrics.egressDenied,
      failuresByErrorCode: Object.fromEntries(Array.from(runnerMetrics.failuresByErrorCode.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    };
  });

  app.post("/v1/execute", async (req, reply) => {
    runnerMetrics.executeTotal += 1;
    const bearer = requireBearerToken();
    const auth = String((req.headers as any).authorization ?? "");
    if (bearer) {
      const expected = `Bearer ${bearer}`;
      if (auth !== expected) {
        runnerMetrics.executeRejected += 1;
        return reply.status(401).send({ errorCode: "UNAUTHORIZED", message: { "zh-CN": "未授权", "en-US": "Unauthorized" } });
      }
    }

    const body = req.body as any;
    let parsed: any;
    try {
      parsed = z
        .object({
          format: z.literal("runner.execute.v1"),
          requestId: z.string().uuid(),
          issuedAt: z.string().min(10),
          expiresAt: z.string().min(10),
          scope: z.object({ tenantId: z.string().min(1), spaceId: z.string().min(1).nullable(), subjectId: z.string().min(1).nullable() }),
          jobRef: z.object({ jobId: z.string().min(1), runId: z.string().min(1), stepId: z.string().min(1) }),
          toolRef: z.string().min(3),
          artifactRef: z.string().min(3).nullable(),
          depsDigest: z.string().min(8).nullable(),
          input: z.any(),
          inputDigest: z.object({ sha256: z.string().min(8), sha256_8: z.string().min(8), bytes: z.number().int().nonnegative() }),
          capabilityEnvelope: z.any(),
          policyDigests: z.object({ networkPolicySha256_8: z.string().min(8) }),
          signature: z
            .object({ alg: z.literal("ed25519"), keyId: z.string().min(1), signedDigest: z.string().min(8), sigBase64: z.string().min(16) })
            .optional(),
        })
        .parse(body);
    } catch {
      return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "请求格式无效", "en-US": "Invalid request" } });
    }

    const expMs = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      runnerMetrics.executeRejected += 1;
      return reply.status(403).send({ errorCode: "TRUST_NOT_VERIFIED", message: { "zh-CN": "请求已过期", "en-US": "Request expired" } });
    }

    const envRes = validateCapabilityEnvelopeV1(parsed.capabilityEnvelope);
    if (!envRes.ok) {
      runnerMetrics.executeRejected += 1;
      return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "capabilityEnvelope 无效", "en-US": "Invalid capabilityEnvelope" } });
    }
    const envelope = envRes.envelope;

    if (envelope.dataDomain.tenantId !== parsed.scope.tenantId) {
      runnerMetrics.executeRejected += 1;
      return reply.status(403).send({ errorCode: "POLICY_VIOLATION", message: { "zh-CN": "scope 不匹配", "en-US": "Scope mismatch" } });
    }

    const policyDigest8 = networkPolicyDigest8(envelope.egressDomain.networkPolicy);
    if (policyDigest8 !== parsed.policyDigests.networkPolicySha256_8) {
      runnerMetrics.executeRejected += 1;
      return reply.status(403).send({ errorCode: "POLICY_VIOLATION", message: { "zh-CN": "networkPolicyDigest 不匹配", "en-US": "networkPolicyDigest mismatch" } });
    }

    const trustedWorkerKeys = loadTrustedWorkerKeysFromEnv();
    const mustVerifySig = requireSignature();
    if (mustVerifySig) {
      const v = verifyRunnerRequestSignatureV1({ req: parsed as RunnerExecuteRequestV1, trustedKeys: trustedWorkerKeys });
      if (!v.ok) {
        runnerMetrics.executeRejected += 1;
        return reply.status(403).send({ errorCode: "TRUST_NOT_VERIFIED", message: { "zh-CN": "请求签名不可信", "en-US": "Request signature not trusted" } });
      }
    }

    const limits = normalizeRuntimeLimitsV1((envelope as CapabilityEnvelopeV1).resourceDomain.limits);
    const networkPolicy = normalizeNetworkPolicyV1((envelope as CapabilityEnvelopeV1).egressDomain.networkPolicy) as unknown as NetworkPolicy;

    const concurrencyKey = `${parsed.scope.tenantId}:${parsed.toolRef}`;
    const startedAt = Date.now();

    let output: any = null;
    let egressEvents: any[] = [];
    let egressCount = 0;
    let egressAllowed = 0;
    let egressDenied = 0;
    let outputBytes = 0;
    let status: "succeeded" | "failed" = "failed";
    let errorCode: any = null;
    let errorCategory: any = null;

    try {
      if (!parsed.artifactRef) throw new Error("policy_violation:missing_artifact_ref");
      const res = await withConcurrency(concurrencyKey, limits.maxConcurrency, async () => {
        return withTimeout(limits.timeoutMs, async (signal) => {
          return executeSkillInSandbox({
            toolRef: parsed.toolRef,
            tenantId: parsed.scope.tenantId,
            spaceId: parsed.scope.spaceId,
            subjectId: parsed.scope.subjectId,
            traceId: typeof (req.headers as any)["x-trace-id"] === "string" ? String((req.headers as any)["x-trace-id"]) : "",
            idempotencyKey:
              typeof (req.headers as any)["idempotency-key"] === "string"
                ? String((req.headers as any)["idempotency-key"])
                : typeof (req.headers as any)["x-idempotency-key"] === "string"
                  ? String((req.headers as any)["x-idempotency-key"])
                  : null,
            input: parsed.input,
            limits,
            networkPolicy,
            artifactRef: parsed.artifactRef!,
            expectedDepsDigest: parsed.depsDigest,
            signal,
          });
        });
      });
      output = res.output;
      const egress = res.egress;
      egressEvents = egress;
      egressCount = egress.length;
      for (const ev of egress) {
        if (ev.allowed) egressAllowed += 1;
        else egressDenied += 1;
      }
      outputBytes = jsonByteLength(output);
      if (outputBytes > limits.maxOutputBytes) throw new Error("resource_exhausted:max_output_bytes");
      status = "succeeded";
    } catch (e: any) {
      const raw = String(e?.message ?? e ?? "internal");
      const errEgress = Array.isArray((e as any)?.egress) ? ((e as any).egress as any[]) : [];
      if (errEgress.length) {
        egressEvents = errEgress;
        egressCount = errEgress.length;
        egressAllowed = 0;
        egressDenied = 0;
        for (const ev of errEgress) {
          if (ev && typeof ev === "object" && (ev as any).allowed) egressAllowed += 1;
          else egressDenied += 1;
        }
      }
      const cls = classifyError(raw);
      status = "failed";
      errorCategory = cls.errorCategory;
      errorCode = cls.errorCode;
      output = null;
    }

    const latencyMs = Date.now() - startedAt;
    const outStable = stableStringify(output);
    const outSha = sha256Hex(outStable);
    outputBytes = Buffer.byteLength(outStable, "utf8");
    const resp: RunnerExecuteResponseV1 = {
      format: "runner.execute.v1",
      requestId: parsed.requestId,
      status,
      errorCode,
      errorCategory,
      output,
      outputDigest: { sha256: `sha256:${outSha}`, sha256_8: outSha.slice(0, 8), bytes: outputBytes },
      egressSummary: { allowed: egressAllowed, denied: egressDenied },
      egressEvents,
      resourceUsageSummary: { latencyMs, outputBytes, egressRequests: egressCount },
    };

    runnerMetrics.egressAllowed += egressAllowed;
    runnerMetrics.egressDenied += egressDenied;

    // 审计日志持久化
    if (egressEvents.length) {
      pushEgressAudit(
        { requestId: parsed.requestId, toolRef: parsed.toolRef, tenantId: parsed.scope.tenantId },
        egressEvents,
      );
    }

    if (status === "succeeded") runnerMetrics.executeSucceeded += 1;
    else {
      runnerMetrics.executeFailed += 1;
      incMap(runnerMetrics.failuresByErrorCode, String(errorCode ?? "UNKNOWN"));
    }

    const sk = runnerSigningKey();
    if (sk) resp.runnerSignature = signRunnerResponseV1({ res: resp, keyId: sk.keyId, privateKeyPem: sk.privateKeyPem });

    const digest = computeRunnerRequestBodyDigestV1(parsed as any);
    reply.header("x-runner-request-digest", digest);
    return resp;
  });

  app.post("/", async (req, reply) => {
    const body = req.body as any;
    if (body && typeof body === "object" && body.type === "ping") return { ok: true, now: nowIso() };
    return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "not found", "en-US": "not found" } });
  });

  return app;
}
