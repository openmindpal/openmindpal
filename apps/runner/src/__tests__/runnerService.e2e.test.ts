import crypto from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../server";

const cwd = process.cwd();
const isRunnerCwd = cwd.replaceAll("\\", "/").endsWith("/apps/runner");
const repoRoot = isRunnerCwd ? path.resolve(cwd, "..", "..") : cwd;
const skillsRoot = path.resolve(repoRoot, "skills");
const sleepSkillRoot = path.resolve(repoRoot, "apps", "runner", "src", "__tests__", "fixtures", "sleep-skill");

function buildEnvelope(params: { tenantId: string; spaceId: string | null; subjectId: string | null; allowedDomains: string[]; timeoutMs: number }) {
  return {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: null, rowFilters: null },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: { allowedDomains: params.allowedDomains, rules: [] } },
    resourceDomain: { limits: { timeoutMs: params.timeoutMs, maxConcurrency: 10, memoryMb: null, cpuMs: null, maxOutputBytes: 100_000, maxEgressRequests: 5 } },
  };
}

function policyDigest8(policy: any) {
  const s = JSON.stringify(
    (function stable(v: any): any {
      if (v === null || v === undefined) return null;
      if (typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(stable);
      const keys = Object.keys(v).sort();
      const out: any = {};
      for (const k of keys) out[k] = stable(v[k]);
      return out;
    })(policy),
  );
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function dummyInputDigest() {
  const sha = "0".repeat(64);
  return { sha256: `sha256:${sha}`, sha256_8: sha.slice(0, 8), bytes: 1 };
}

describe.sequential("runner service e2e", () => {
  afterEach(() => {
    delete process.env.RUNNER_BEARER_TOKEN;
    delete process.env.RUNNER_REQUIRE_SIGNATURE;
    delete process.env.RUNNER_TRUSTED_WORKER_KEYS_JSON;
    delete process.env.RUNNER_SIGNING_KEY_ID;
    delete process.env.RUNNER_SIGNING_PRIVATE_KEY_PEM;
    delete process.env.SKILL_PACKAGE_ROOTS;
  });

  it("healthz/capabilities", async () => {
    const app = buildServer();
    await app.ready();
    const h = await app.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect((h.json() as any).ok).toBe(true);
    const c = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(c.statusCode).toBe(200);
    expect((c.json() as any).runner?.version).toBe("v1");
    await app.close();
  });

  it("policy_violation: 出站默认拒绝", async () => {
    process.env.SKILL_PACKAGE_ROOTS = skillsRoot;
    process.env.RUNNER_REQUIRE_SIGNATURE = "false";
    const app = buildServer();
    await app.ready();

    const tenantId = "tenant_dev";
    const envelope = buildEnvelope({ tenantId, spaceId: null, subjectId: null, allowedDomains: [], timeoutMs: 2000 });
    const policy = envelope.egressDomain.networkPolicy;

    const reqBody: any = {
      format: "runner.execute.v1",
      requestId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: { tenantId, spaceId: null, subjectId: null },
      jobRef: { jobId: "j1", runId: "r1", stepId: "s1" },
      toolRef: "http.fetch@1",
      artifactRef: path.resolve(skillsRoot, "http-fetch-skill"),
      depsDigest: null,
      input: { url: "https://example.com" },
      inputDigest: dummyInputDigest(),
      capabilityEnvelope: envelope,
      policyDigests: { networkPolicySha256_8: policyDigest8(policy) },
    };

    const res = await app.inject({ method: "POST", url: "/v1/execute", payload: reqBody });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.status).toBe("failed");
    expect(body.errorCategory).toBe("policy_violation");
    expect(body.egressSummary.denied).toBeGreaterThan(0);
    await app.close();
  });

  it("timeout: 强制终止", async () => {
    process.env.SKILL_PACKAGE_ROOTS = `${skillsRoot};${path.dirname(sleepSkillRoot)}`;
    process.env.RUNNER_REQUIRE_SIGNATURE = "false";
    const app = buildServer();
    await app.ready();

    const tenantId = "tenant_dev";
    const envelope = buildEnvelope({ tenantId, spaceId: null, subjectId: null, allowedDomains: [], timeoutMs: 50 });
    const policy = envelope.egressDomain.networkPolicy;
    const artifactRef = sleepSkillRoot;

    const reqBody: any = {
      format: "runner.execute.v1",
      requestId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: { tenantId, spaceId: null, subjectId: null },
      jobRef: { jobId: "j1", runId: "r1", stepId: "s1" },
      toolRef: "test.sleep@1",
      artifactRef,
      depsDigest: null,
      input: { ms: 500 },
      inputDigest: dummyInputDigest(),
      capabilityEnvelope: envelope,
      policyDigests: { networkPolicySha256_8: policyDigest8(policy) },
    };

    const res = await app.inject({ method: "POST", url: "/v1/execute", payload: reqBody });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.status).toBe("failed");
    expect(body.errorCategory).toBe("timeout");
    expect(body.errorCode).toBe("TIMEOUT");
    await app.close();
  });

  it("runnerSignature: 返回签名可验证", async () => {
    process.env.SKILL_PACKAGE_ROOTS = skillsRoot;
    process.env.RUNNER_REQUIRE_SIGNATURE = "false";
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    process.env.RUNNER_SIGNING_KEY_ID = "runner_k1";
    process.env.RUNNER_SIGNING_PRIVATE_KEY_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const app = buildServer();
    await app.ready();

    const tenantId = "tenant_dev";
    const envelope = buildEnvelope({ tenantId, spaceId: null, subjectId: null, allowedDomains: [], timeoutMs: 2000 });
    const policy = envelope.egressDomain.networkPolicy;
    const artifactRef = path.resolve(skillsRoot, "echo-skill");

    const requestId = crypto.randomUUID();
    const reqBody: any = {
      format: "runner.execute.v1",
      requestId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: { tenantId, spaceId: null, subjectId: null },
      jobRef: { jobId: "j1", runId: "r1", stepId: "s1" },
      toolRef: "echo@1",
      artifactRef,
      depsDigest: null,
      input: { any: "x" },
      inputDigest: dummyInputDigest(),
      capabilityEnvelope: envelope,
      policyDigests: { networkPolicySha256_8: policyDigest8(policy) },
    };

    const res = await app.inject({ method: "POST", url: "/v1/execute", payload: reqBody });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.runnerSignature?.alg).toBe("ed25519");
    expect(body.runnerSignature?.keyId).toBe("runner_k1");
    const msg = `openslin:runner:result:${body.runnerSignature.signedDigest}`;
    const ok = crypto.verify(null, Buffer.from(msg, "utf8"), publicKey, Buffer.from(body.runnerSignature.sigBase64, "base64"));
    expect(ok).toBe(true);
    await app.close();
  });
});
