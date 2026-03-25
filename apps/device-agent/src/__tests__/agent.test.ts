import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeviceAgentConfig } from "../config";
import { heartbeatOnce, runOnce } from "../agent";
import { registerPlugin, clearPlugins } from "../pluginRegistry";
import desktopPlugin from "../plugins/desktopPlugin";

function json(res: http.ServerResponse, status: number, body: any) {
  const txt = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(txt);
}

function readBody(req: http.IncomingMessage) {
  return new Promise<any>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      const txt = Buffer.concat(chunks).toString("utf8");
      resolve(txt ? JSON.parse(txt) : null);
    });
  });
}

describe("device-agent", () => {
  let server: http.Server;
  let base: string;
  let hits: any[] = [];
  let pendingOnce = true;
  let requireUserPresence = false;
  let pendingToolRef = "noop@1";
  let pendingInput: any = { a: 1 };
  let pendingPolicy: any = { allowedTools: ["noop", "echo"], filePolicy: null, networkPolicy: null, uiPolicy: null, evidencePolicy: null, limits: null };

  beforeAll(async () => {
    // 注册内置桌面插件（测试需要）
    clearPlugins();
    registerPlugin(desktopPlugin);

    server = http.createServer(async (req, res) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";
      const auth = String(req.headers.authorization ?? "");
      if (url === "/device-agent/heartbeat" && method === "POST") {
        hits.push({ url, method, auth, body: await readBody(req) });
        if (auth !== "Device tok") return json(res, 403, { errorCode: "FORBIDDEN" });
        return json(res, 200, { ok: true });
      }
      if (url.startsWith("/device-agent/executions/pending") && method === "GET") {
        hits.push({ url, method, auth });
        if (auth !== "Device tok") return json(res, 403, { errorCode: "FORBIDDEN" });
        if (pendingOnce) {
          pendingOnce = false;
          return json(res, 200, { executions: [{ deviceExecutionId: "e1", toolRef: pendingToolRef }] });
        }
        return json(res, 200, { executions: [] });
      }
      if (url === "/device-agent/executions/e1/claim" && method === "POST") {
        hits.push({ url, method, auth, body: await readBody(req) });
        if (auth !== "Device tok") return json(res, 403, { errorCode: "FORBIDDEN" });
        return json(res, 200, { execution: { deviceExecutionId: "e1", toolRef: pendingToolRef, input: pendingInput }, requireUserPresence, policy: pendingPolicy });
      }
      if (url === "/device-agent/executions/e1/result" && method === "POST") {
        hits.push({ url, method, auth, body: await readBody(req) });
        if (auth !== "Device tok") return json(res, 403, { errorCode: "FORBIDDEN" });
        return json(res, 200, { ok: true });
      }
      json(res, 404, { errorCode: "NOT_FOUND" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("heartbeatOnce works", async () => {
    hits = [];
    const cfg: DeviceAgentConfig = {
      apiBase: base,
      deviceId: "d1",
      deviceToken: "tok",
      enrolledAt: new Date().toISOString(),
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const r = await heartbeatOnce({ cfg });
    expect(r.ok).toBe(true);
    expect(hits.some((h) => h.url === "/device-agent/heartbeat")).toBe(true);
  });

  it("runOnce executes pending noop", async () => {
    hits = [];
    pendingOnce = true;
    requireUserPresence = false;
    pendingToolRef = "noop@1";
    pendingInput = { a: 1 };
    pendingPolicy = { allowedTools: ["noop", "echo"], filePolicy: null, networkPolicy: null, uiPolicy: null, evidencePolicy: null, limits: null };
    const cfg: DeviceAgentConfig = {
      apiBase: base,
      deviceId: "d1",
      deviceToken: "tok",
      enrolledAt: new Date().toISOString(),
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const r = await runOnce({ cfg, confirmFn: async () => true, now: () => new Date() });
    expect(r.ok).toBe(true);
    const resultHit = hits.find((h) => h.url === "/device-agent/executions/e1/result");
    expect(resultHit).toBeTruthy();
    expect(resultHit.body.status).toBe("succeeded");
  });

  it("requireUserPresence denies execution", async () => {
    hits = [];
    pendingOnce = true;
    requireUserPresence = true;
    pendingToolRef = "noop@1";
    pendingInput = { a: 1 };
    pendingPolicy = { allowedTools: ["noop", "echo"], filePolicy: null, networkPolicy: null, uiPolicy: null, evidencePolicy: null, limits: null };
    const cfg: DeviceAgentConfig = {
      apiBase: base,
      deviceId: "d1",
      deviceToken: "tok",
      enrolledAt: new Date().toISOString(),
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const r = await runOnce({ cfg, confirmFn: async () => false, now: () => new Date() });
    expect(r.ok).toBe(true);
    const resultHit = hits.find((h) => h.url === "/device-agent/executions/e1/result");
    expect(resultHit.body.status).toBe("failed");
    expect(resultHit.body.errorCategory).toBe("user_denied");
  });

  it("device.file.read enforces allowedRoots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "da-"));
    const fp = path.join(dir, "a.txt");
    await fs.writeFile(fp, "hello", "utf8");

    hits = [];
    pendingOnce = true;
    requireUserPresence = false;
    pendingToolRef = "device.file.read@1";
    pendingInput = { path: fp };
    pendingPolicy = { allowedTools: ["device.file.read"], filePolicy: { allowRead: true, allowedRoots: [dir], maxBytesPerRead: 1024 }, networkPolicy: null, uiPolicy: null, evidencePolicy: null, limits: null };

    const cfg: DeviceAgentConfig = {
      apiBase: base,
      deviceId: "d1",
      deviceToken: "tok",
      enrolledAt: new Date().toISOString(),
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const r = await runOnce({ cfg, confirmFn: async () => true, now: () => new Date() });
    expect(r.ok).toBe(true);
    const resultHit = hits.find((h) => h.url === "/device-agent/executions/e1/result");
    expect(resultHit.body.status).toBe("succeeded");
    expect(resultHit.body.outputDigest?.byteSize).toBe(5);
  });

  it("device.file.read denies path outside roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "da-"));
    const fp = path.join(dir, "a.txt");
    await fs.writeFile(fp, "hello", "utf8");

    hits = [];
    pendingOnce = true;
    requireUserPresence = false;
    pendingToolRef = "device.file.read@1";
    pendingInput = { path: fp };
    pendingPolicy = { allowedTools: ["device.file.read"], filePolicy: { allowRead: true, allowedRoots: [path.join(dir, "other")], maxBytesPerRead: 1024 }, networkPolicy: null, uiPolicy: null, evidencePolicy: null, limits: null };

    const cfg: DeviceAgentConfig = {
      apiBase: base,
      deviceId: "d1",
      deviceToken: "tok",
      enrolledAt: new Date().toISOString(),
      deviceType: "desktop",
      os: "windows",
      agentVersion: "1.0.0",
    };
    const r = await runOnce({ cfg, confirmFn: async () => true, now: () => new Date() });
    expect(r.ok).toBe(true);
    const resultHit = hits.find((h) => h.url === "/device-agent/executions/e1/result");
    expect(resultHit.body.status).toBe("failed");
    expect(resultHit.body.errorCategory).toBe("policy_violation");
  });
});
