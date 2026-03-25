import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { executeDynamicSkillRemote } from "../workflow/processor/dynamicSkill";

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function envelope(tenantId: string) {
  return {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId,
      spaceId: null,
      subjectId: null,
      toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: null, rowFilters: null },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: { allowedDomains: [], rules: [] } },
    resourceDomain: { limits: { timeoutMs: 500, maxConcurrency: 10, memoryMb: null, cpuMs: null, maxOutputBytes: 100_000, maxEgressRequests: 5 } },
  } as any;
}

describe("remote runner client", () => {
  it("runner 不可用 => remote_runtime_failed", async () => {
    const controller = new AbortController();
    await expect(
      executeDynamicSkillRemote({
        endpoint: "http://127.0.0.1:1",
        bearerToken: null,
        jobId: "j",
        runId: "r",
        stepId: "s",
        requestId: crypto.randomUUID(),
        toolRef: "echo@1",
        tenantId: "tenant_dev",
        spaceId: null,
        subjectId: null,
        traceId: "t",
        idempotencyKey: null,
        input: { x: 1 },
        limits: { timeoutMs: 200, maxConcurrency: 10, memoryMb: null, cpuMs: null, maxOutputBytes: 100_000, maxEgressRequests: 5 } as any,
        networkPolicy: { allowedDomains: [], rules: [] } as any,
        capabilityEnvelope: envelope("tenant_dev"),
        artifactRef: "artifact:noop",
        depsDigest: "sha256:x",
        trustedKeys: new Map(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/policy_violation:remote_runtime_failed/);
  });

  it("403 TRUST_NOT_VERIFIED => trust_not_verified", async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.includes("/v1/execute")) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ errorCode: "TRUST_NOT_VERIFIED", message: { "zh-CN": "x", "en-US": "x" } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const controller = new AbortController();
    try {
      await expect(
        executeDynamicSkillRemote({
          endpoint: srv.url,
          bearerToken: null,
          jobId: "j",
          runId: "r",
          stepId: "s",
          requestId: crypto.randomUUID(),
          toolRef: "echo@1",
          tenantId: "tenant_dev",
          spaceId: null,
          subjectId: null,
          traceId: "t",
          idempotencyKey: null,
          input: { x: 1 },
          limits: { timeoutMs: 200, maxConcurrency: 10, memoryMb: null, cpuMs: null, maxOutputBytes: 100_000, maxEgressRequests: 5 } as any,
          networkPolicy: { allowedDomains: [], rules: [] } as any,
          capabilityEnvelope: envelope("tenant_dev"),
          artifactRef: "artifact:noop",
          depsDigest: "sha256:x",
          trustedKeys: new Map(),
          signal: controller.signal,
        }),
      ).rejects.toThrow(/policy_violation:trust_not_verified/);
    } finally {
      await srv.close();
    }
  });

  it("200 但返回非 JSON => bad_output", async () => {
    const srv = await startServer((req, res) => {
      if (req.url?.includes("/v1/execute")) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("not json");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const controller = new AbortController();
    try {
      await expect(
        executeDynamicSkillRemote({
          endpoint: srv.url,
          bearerToken: null,
          jobId: "j",
          runId: "r",
          stepId: "s",
          requestId: crypto.randomUUID(),
          toolRef: "echo@1",
          tenantId: "tenant_dev",
          spaceId: null,
          subjectId: null,
          traceId: "t",
          idempotencyKey: null,
          input: { x: 1 },
          limits: { timeoutMs: 200, maxConcurrency: 10, memoryMb: null, cpuMs: null, maxOutputBytes: 100_000, maxEgressRequests: 5 } as any,
          networkPolicy: { allowedDomains: [], rules: [] } as any,
          capabilityEnvelope: envelope("tenant_dev"),
          artifactRef: "artifact:noop",
          depsDigest: "sha256:x",
          trustedKeys: new Map(),
          signal: controller.signal,
        }),
      ).rejects.toThrow(/policy_violation:remote_runtime_bad_output/);
    } finally {
      await srv.close();
    }
  });
});

