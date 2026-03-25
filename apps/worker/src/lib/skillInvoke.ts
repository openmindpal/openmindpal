import Module from "node:module";
import crypto from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { executeDynamicSkillSandboxed } from "../workflow/processor/dynamicSkillSandbox";
import type { RuntimeLimits, NetworkPolicy } from "../workflow/processor/runtime";

/**
 * 获取 skill 包的搜索根目录列表。
 * 与 dynamicSkill.ts 中 getSkillRoots 保持一致。
 */
function getSkillRoots(): string[] {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw.split(/[;,]/g).map((x) => x.trim()).filter(Boolean);
  if (parts.length) return parts.map((p) => path.resolve(p));
  const defaults = [
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "..", "..", "skills"),
  ];
  return defaults.filter((p) => existsSync(p));
}

/** first-party skill 的默认安全约束 */
const FIRST_PARTY_LIMITS: RuntimeLimits = {
  timeoutMs: 30_000,
  maxConcurrency: 5,
  memoryMb: 256,
  cpuMs: null,
  maxOutputBytes: 2_000_000,
  maxEgressRequests: 20,
};

const FIRST_PARTY_NETWORK_POLICY: NetworkPolicy = {
  allowedDomains: ["*"],
  rules: [],
};

/**
 * 调用一个 first-party skill 的 execute 函数（经过沙箱受控执行路径）。
 *
 * P0-1: 消除执行旁路——所有 first-party skill 调用现在均经过沙箱隔离，
 * 包含模块加载阻断、网络策略、RuntimeLimits、审计摘要。
 *
 * @param params.skillDir  skill 包在 skills/ 下的目录名，如 "slack-send-skill"
 * @param params.input     传给 skill execute 的 input 字段
 * @param params.traceId   可选 traceId
 * @param params.tenantId  可选 tenantId
 * @param params.spaceId   可选 spaceId
 * @param params.limits    可选 RuntimeLimits 覆盖
 * @param params.networkPolicy 可选 NetworkPolicy 覆盖
 */
export async function invokeFirstPartySkill<TInput = any, TOutput = any>(params: {
  skillDir: string;
  input: TInput;
  traceId?: string;
  tenantId?: string;
  spaceId?: string | null;
  limits?: Partial<RuntimeLimits>;
  networkPolicy?: Partial<NetworkPolicy>;
}): Promise<TOutput> {
  const roots = getSkillRoots();
  let artifactDir: string | null = null;
  for (const root of roots) {
    const candidate = path.resolve(root, params.skillDir);
    if (existsSync(candidate)) {
      artifactDir = candidate;
      break;
    }
  }
  if (!artifactDir) throw new Error(`skill_not_found:${params.skillDir}`);

  const manifestPath = path.join(artifactDir, "manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const entryRel = String(manifest?.entry ?? "");
  if (!entryRel) throw new Error(`skill_missing_entry:${params.skillDir}`);

  const entryPath = path.resolve(artifactDir, entryRel);
  const traceId = params.traceId || crypto.randomUUID();
  const toolRef = `${params.skillDir}@first-party`;
  const depsDigest = `first-party:${params.skillDir}`;
  const artifactRef = `local:${artifactDir}`;

  const limits: RuntimeLimits = {
    ...FIRST_PARTY_LIMITS,
    ...(params.limits ?? {}),
  };
  const networkPolicy: NetworkPolicy = {
    allowedDomains: params.networkPolicy?.allowedDomains ?? FIRST_PARTY_NETWORK_POLICY.allowedDomains,
    rules: params.networkPolicy?.rules ?? FIRST_PARTY_NETWORK_POLICY.rules,
  };

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), limits.timeoutMs + 5_000);

  try {
    const result = await executeDynamicSkillSandboxed({
      toolRef,
      tenantId: params.tenantId ?? "",
      spaceId: params.spaceId ?? null,
      subjectId: null,
      traceId,
      idempotencyKey: null,
      input: params.input,
      limits,
      networkPolicy,
      artifactRef,
      depsDigest,
      entryPath,
      signal: ac.signal,
    });
    return result.output as TOutput;
  } catch (e: any) {
    console.warn(`[invokeFirstPartySkill] sandbox execution failed for ${params.skillDir}`, {
      traceId,
      error: String(e?.message ?? e),
    });
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

