import Module from "node:module";
import type { EgressEvent, NetworkPolicy } from "./processor/runtime";
import { isAllowedEgress, normalizeNetworkPolicy } from "./processor/runtime";

function pickExecute(mod: any) {
  if (mod && typeof mod.execute === "function") return mod.execute as (req: any) => Promise<any>;
  if (mod && mod.default && typeof mod.default.execute === "function") return mod.default.execute as (req: any) => Promise<any>;
  if (mod && typeof mod.default === "function") return mod.default as (req: any) => Promise<any>;
  return null;
}

function sandboxMode(): "strict" | "compat" {
  const raw = String(process.env.SKILL_SANDBOX_MODE ?? "").trim().toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "compat") return "compat";
  return process.env.NODE_ENV === "production" ? "strict" : "compat";
}

function forbiddenModules(mode: "strict" | "compat") {
  const base = new Set<string>([
    "node:child_process",
    "child_process",
    "node:net",
    "net",
    "node:tls",
    "tls",
    "node:dns",
    "dns",
    "node:http",
    "http",
    "node:https",
    "https",
    "node:dgram",
    "dgram",
  ]);
  if (mode === "compat") return base;
  const strict = [
    "node:fs",
    "fs",
    "node:fs/promises",
    "fs/promises",
    "node:worker_threads",
    "worker_threads",
    "node:vm",
    "vm",
    "node:inspector",
    "inspector",
    "node:async_hooks",
    "async_hooks",
    "pg",
    "mysql",
    "mysql2",
    "sqlite3",
    "better-sqlite3",
    "mongodb",
    "oracledb",
    "mssql",
    "redis",
    "ioredis",
  ];
  for (const x of strict) base.add(x);
  return base;
}

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;
    if (m.type !== "execute") return;
    const payload = m.payload ?? {};

    const egress: EgressEvent[] = [];
    const networkPolicy: NetworkPolicy = normalizeNetworkPolicy(payload?.networkPolicy);
    const originalFetch = globalThis.fetch;
    const mode = sandboxMode();
    const denied = forbiddenModules(mode);
    const origLoad = (Module as any)._load as any;
    const origNodeExt = (Module as any)._extensions?.[".node"] as any;

    const wrappedFetch = async (input: any, init?: any) => {
      const maxEgressRequests =
        typeof payload?.limits?.maxEgressRequests === "number" && Number.isFinite(payload.limits.maxEgressRequests)
          ? Math.max(0, Math.round(payload.limits.maxEgressRequests))
          : null;
      if (maxEgressRequests !== null && egress.length >= maxEgressRequests) {
        throw new Error("resource_exhausted:max_egress_requests");
      }
      const url = typeof input === "string" ? input : input?.url ? String(input.url) : "";
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      const chk = isAllowedEgress({ policy: networkPolicy, url, method });
      if (!chk.allowed) {
        egress.push({ host: chk.host, method: chk.method, allowed: false, errorCategory: "policy_violation" });
        throw new Error(chk.reason ?? "policy_violation:egress_denied");
      }
      const res = await originalFetch(input as any, init as any);
      egress.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: (res as any)?.status });
      return res;
    };

    try {
      if (typeof originalFetch !== "function") throw new Error("skill_sandbox_missing_fetch");
      globalThis.fetch = wrappedFetch as any;

      (Module as any)._load = function (request: any, parent: any, isMain: any) {
        const req = String(request ?? "");
        const norm = req.startsWith("node:") ? req : req ? `node:${req}` : req;
        if (denied.has(req) || denied.has(norm)) {
          const base = req.startsWith("node:") ? req.slice("node:".length) : req;
          throw new Error(`policy_violation:skill_forbidden_import:${base}`);
        }
        return origLoad.call(this, request, parent, isMain);
      };
      if ((Module as any)._extensions) {
        (Module as any)._extensions[".node"] = function () {
          throw new Error("policy_violation:skill_native_addon_not_allowed");
        };
      }

      const entryPath = String(payload.entryPath ?? "");
      if (!entryPath) throw new Error("skill_sandbox_missing_entry_path");
      const req = Module.createRequire(entryPath);
      const mod = req(entryPath);
      const exec = pickExecute(mod);
      if (!exec) throw new Error("policy_violation:skill_missing_execute");

      const output = await exec({
        toolRef: payload.toolRef,
        tenantId: payload.tenantId,
        spaceId: payload.spaceId,
        subjectId: payload.subjectId,
        traceId: payload.traceId,
        idempotencyKey: payload.idempotencyKey,
        input: payload.input,
        limits: payload.limits,
        networkPolicy: payload.networkPolicy,
        artifactRef: payload.artifactRef,
        depsDigest: payload.depsDigest,
      });

      (process as any).send?.({
        type: "result",
        ok: true,
        output,
        depsDigest: payload.depsDigest,
        egress,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "skill_sandbox_error");
      (process as any).send?.({
        type: "result",
        ok: false,
        error: { message: msg },
        depsDigest: payload.depsDigest,
        egress,
      });
    } finally {
      globalThis.fetch = originalFetch as any;
      (Module as any)._load = origLoad;
      if ((Module as any)._extensions) {
        (Module as any)._extensions[".node"] = origNodeExt;
      }
    }
  });
}

void main();
