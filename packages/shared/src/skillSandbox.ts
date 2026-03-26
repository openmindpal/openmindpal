/**
 * skillSandbox.ts — Skill 沙箱基线模块
 *
 * 统一 Worker 与 Runner 的沙箱安全策略，确保拦截行为一致。
 * 包含：模块封禁列表、动态代码执行锁定、沙箱模式解析、入口提取。
 *
 * @module @openslin/shared/skillSandbox
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SandboxMode = "strict" | "compat";

// ─────────────────────────────────────────────────────────────────────────────
// 模块封禁列表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 基线封禁模块 — 所有沙箱模式下都禁止
 * 包含网络、子进程等高危模块
 */
export const SANDBOX_FORBIDDEN_MODULES_BASE = Object.freeze([
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
] as const);

/**
 * 严格模式额外封禁模块 — 仅 strict 模式下禁止
 * 包含文件系统、Worker、VM 等
 */
export const SANDBOX_FORBIDDEN_MODULES_STRICT = Object.freeze([
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
] as const);

/**
 * 数据库模块封禁列表 — Worker 侧额外禁止
 * 防止 Skill 直接访问数据库
 */
export const SANDBOX_FORBIDDEN_MODULES_DATABASE = Object.freeze([
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
] as const);

// ─────────────────────────────────────────────────────────────────────────────
// 沙箱模式解析
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析沙箱模式
 * @param env 环境变量（默认 process.env）
 * @returns "strict" | "compat"
 */
export function resolveSandboxMode(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SandboxMode {
  const raw = String(env.SKILL_SANDBOX_MODE ?? "").trim().toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "compat") return "compat";
  // 生产环境默认 strict，开发环境默认 compat
  return (env.NODE_ENV ?? "development") === "production" ? "strict" : "compat";
}

/**
 * 构建封禁模块集合
 * @param mode 沙箱模式
 * @param extras 额外封禁模块列表（如数据库模块）
 * @returns 封禁模块集合
 */
export function buildForbiddenModulesSet(
  mode: SandboxMode,
  extras: readonly string[] = [],
): Set<string> {
  const set = new Set<string>(SANDBOX_FORBIDDEN_MODULES_BASE);
  if (mode === "strict") {
    for (const m of SANDBOX_FORBIDDEN_MODULES_STRICT) {
      set.add(m);
    }
  }
  for (const m of extras) {
    set.add(m);
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// 动态代码执行锁定
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicCodeLockState {
  origEval: typeof eval;
  origFunction: FunctionConstructor;
}

/**
 * 封禁动态代码执行能力 — 防止 Skill 通过 eval/Function 绕过沙箱
 * @returns 保存的原始引用，用于恢复
 */
export function lockdownDynamicCodeExecution(): DynamicCodeLockState {
  const origEval = globalThis.eval;
  const origFunction = globalThis.Function;
  const blocker = (..._args: unknown[]): never => {
    throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
  };
  (globalThis as Record<string, unknown>).eval = blocker;
  (globalThis as Record<string, unknown>).Function = new Proxy(origFunction, {
    construct(_t, _args): never {
      throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
    },
    apply(_t, _thisArg, _args): never {
      throw new Error("policy_violation:skill_dynamic_code_execution_blocked");
    },
  });
  return { origEval, origFunction };
}

/**
 * 恢复动态代码执行能力
 * @param saved lockdownDynamicCodeExecution 返回的状态
 */
export function restoreDynamicCodeExecution(saved: DynamicCodeLockState): void {
  (globalThis as Record<string, unknown>).eval = saved.origEval;
  (globalThis as Record<string, unknown>).Function = saved.origFunction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill 入口提取
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从模块中提取 execute 函数
 * 支持以下导出形式：
 * - export function execute(req)
 * - export default { execute(req) }
 * - export default function(req)
 *
 * @param mod 模块对象
 * @returns execute 函数或 null
 */
export function pickExecute(mod: unknown): ((req: unknown) => Promise<unknown>) | null {
  if (!mod || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;

  // 直接导出 execute
  if (typeof m.execute === "function") {
    return m.execute as (req: unknown) => Promise<unknown>;
  }

  // default 导出包含 execute
  if (m.default && typeof m.default === "object") {
    const def = m.default as Record<string, unknown>;
    if (typeof def.execute === "function") {
      return def.execute as (req: unknown) => Promise<unknown>;
    }
  }

  // default 直接是函数
  if (typeof m.default === "function") {
    return m.default as (req: unknown) => Promise<unknown>;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块拦截检查
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 检查模块是否被封禁
 * @param moduleName 模块名
 * @param forbiddenSet 封禁模块集合
 * @returns { forbidden: true, baseName } 或 { forbidden: false }
 */
export function checkModuleForbidden(
  moduleName: string,
  forbiddenSet: Set<string>,
): { forbidden: true; baseName: string } | { forbidden: false } {
  const req = String(moduleName ?? "");
  const norm = req.startsWith("node:") ? req : req ? `node:${req}` : req;
  if (forbiddenSet.has(req) || forbiddenSet.has(norm)) {
    const baseName = req.startsWith("node:") ? req.slice("node:".length) : req;
    return { forbidden: true, baseName };
  }
  return { forbidden: false };
}

/**
 * 创建模块加载拦截器
 * @param origLoad 原始 Module._load
 * @param forbiddenSet 封禁模块集合
 * @returns 拦截后的 _load 函数
 */
export function createModuleLoadInterceptor(
  origLoad: (request: string, parent: unknown, isMain: boolean) => unknown,
  forbiddenSet: Set<string>,
): (request: string, parent: unknown, isMain: boolean) => unknown {
  return function interceptedLoad(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    const check = checkModuleForbidden(request, forbiddenSet);
    if (check.forbidden) {
      throw new Error(`policy_violation:skill_forbidden_import:${check.baseName}`);
    }
    return origLoad.call(this, request, parent, isMain);
  };
}
