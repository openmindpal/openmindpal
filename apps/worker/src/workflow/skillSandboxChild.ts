/**
 * skillSandboxChild.ts — Worker 侧 Skill 沙箱子进程
 *
 * 使用统一的沙箱基线模块，确保拦截行为一致。
 * @see packages/shared/src/skillSandbox.ts
 */
import Module from "node:module";
import type { EgressEvent, NetworkPolicy } from "./processor/runtime";
import { isAllowedEgress, normalizeNetworkPolicy } from "./processor/runtime";
import {
  resolveSandboxMode,
  buildForbiddenModulesSet,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
  pickExecute,
  createModuleLoadInterceptor,
} from "@openslin/shared";

async function main() {
  process.on("message", async (m: any) => {
    if (!m || typeof m !== "object") return;
    if (m.type !== "execute") return;
    const payload = m.payload ?? {};

    const egress: EgressEvent[] = [];
    const networkPolicy: NetworkPolicy = normalizeNetworkPolicy(payload?.networkPolicy);
    const originalFetch = globalThis.fetch;
    const mode = resolveSandboxMode();
    // Worker 侧额外禁止数据库模块
    const denied = buildForbiddenModulesSet(mode, SANDBOX_FORBIDDEN_MODULES_DATABASE);
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

      // 使用共享的模块拦截器
      (Module as any)._load = createModuleLoadInterceptor(origLoad, denied);
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
