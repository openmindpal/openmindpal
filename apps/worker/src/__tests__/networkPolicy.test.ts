import child_process from "node:child_process";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedEgress, normalizeNetworkPolicy } from "../workflow/processor/runtime";

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server_no_address"));
        return;
      }
      resolve({ port: addr.port });
    });
  });
}

function forkSkillSandboxChild() {
  const childPath = path.resolve(process.cwd(), "src/workflow/skillSandboxChild.ts");
  return child_process.fork(childPath, [], { execArgv: ["-r", "tsx/cjs"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
}

function runChildExecute(params: {
  entryPath: string;
  input: any;
  networkPolicy: any;
  limits?: any;
}): Promise<any> {
  const child = forkSkillSandboxChild();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      try {
        child.kill();
      } catch {
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child_exit:${code ?? "null"}`));
    };
    const onMessage = (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "result") return;
      cleanup();
      resolve(m);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
    child.send({
      type: "execute",
      payload: {
        toolRef: "test.skill@1",
        tenantId: "tenant_test",
        spaceId: null,
        subjectId: null,
        traceId: "trace_test",
        idempotencyKey: null,
        input: params.input,
        limits: params.limits ?? {},
        networkPolicy: params.networkPolicy,
        artifactRef: "artifact_test",
        depsDigest: "deps_digest_test",
        entryPath: params.entryPath,
      },
    });
  });
}

describe("networkPolicy allow/deny 与 egressSummary 摘要", () => {
  it("normalizeNetworkPolicy + isAllowedEgress：严格按 allowlist/rules 判定并记录命中摘要", () => {
    const policy = normalizeNetworkPolicy({
      allowedDomains: ["Example.COM", "http://bad", "a.com:443", " ok.com "],
      rules: [{ host: "API.Example.com", pathPrefix: "v1", methods: ["post"] }],
    });

    expect(policy.allowedDomains).toEqual(["example.com", "ok.com"]);
    expect(policy.rules[0]).toEqual({ host: "api.example.com", pathPrefix: "/v1", methods: ["POST"] });

    const a = isAllowedEgress({ policy, url: "https://example.com/a?b=c", method: "get" });
    expect(a.allowed).toBe(true);
    if (a.allowed) {
      expect(a.host).toBe("example.com");
      expect(a.match.kind).toBe("allowedDomain");
    }

    const b = isAllowedEgress({ policy, url: "https://api.example.com/v1/x", method: "POST" });
    expect(b.allowed).toBe(true);
    if (b.allowed) {
      expect(b.match.kind).toBe("rule");
      expect(b.match.rulePathPrefix).toBe("/v1");
    }

    const c = isAllowedEgress({ policy, url: "ftp://example.com/a", method: "GET" });
    expect(c.allowed).toBe(false);
    if (!c.allowed) expect(c.reason).toMatch(/^policy_violation:egress_invalid_protocol:/);
  });

  it("skillSandboxChild：fetch 拦截按 rules 放行且不泄露 URL 明文", async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/ok")) {
        res.statusCode = 200;
        res.end("ok");
        return;
      }
      res.statusCode = 404;
      res.end("not_found");
    });
    const { port } = await listen(server);
    try {
      const entryPath = path.resolve(__dirname, "./fixtures/skillFetchOnce.ts");
      const url = `http://127.0.0.1:${port}/ok?q=1`;
      const out = await runChildExecute({
        entryPath,
        input: { url, method: "GET" },
        networkPolicy: { allowedDomains: [], rules: [{ host: "127.0.0.1", pathPrefix: "ok", methods: ["get"] }] },
        limits: { maxEgressRequests: 5 },
      });
      expect(out.ok).toBe(true);
      expect(out.output?.status).toBe(200);
      expect(out.egress?.length).toBe(1);
      expect(out.egress[0]).toMatchObject({ host: "127.0.0.1", method: "GET", allowed: true });
      expect(out.egress[0]?.policyMatch?.kind).toBe("rule");
      expect(out.egress[0]?.policyMatch?.rulePathPrefix).toBe("/ok");
      const summaryText = JSON.stringify(out.egress);
      expect(summaryText).not.toContain("?q=1");
      expect(summaryText).not.toContain(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("skillSandboxChild：fetch 被拒绝时记录摘要但不泄露路径/查询串", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const { port } = await listen(server);
    try {
      const entryPath = path.resolve(__dirname, "./fixtures/skillFetchOnce.ts");
      const url = `http://127.0.0.1:${port}/secret?token=abc`;
      const out = await runChildExecute({
        entryPath,
        input: { url, method: "GET" },
        networkPolicy: { allowedDomains: ["example.com"], rules: [] },
        limits: { maxEgressRequests: 5 },
      });
      expect(out.ok).toBe(false);
      expect(String(out.error?.message ?? "")).toMatch(/^policy_violation:/);
      expect(out.egress?.length).toBe(1);
      expect(out.egress[0]).toMatchObject({ host: "127.0.0.1", method: "GET", allowed: false, errorCategory: "policy_violation" });
      const summaryText = JSON.stringify(out.egress);
      expect(summaryText).not.toContain("/secret");
      expect(summaryText).not.toContain("?token=abc");
      expect(summaryText).not.toContain(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("skillSandboxChild：maxEgressRequests 生效", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    const { port } = await listen(server);
    try {
      const entryPath = path.resolve(__dirname, "./fixtures/skillFetchTwice.ts");
      const url1 = `http://127.0.0.1:${port}/a`;
      const url2 = `http://127.0.0.1:${port}/b`;
      const out = await runChildExecute({
        entryPath,
        input: { urls: [url1, url2] },
        networkPolicy: { allowedDomains: ["127.0.0.1"], rules: [] },
        limits: { maxEgressRequests: 1 },
      });
      expect(out.ok).toBe(false);
      expect(String(out.error?.message ?? "")).toBe("resource_exhausted:max_egress_requests");
      expect(out.egress?.length).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
