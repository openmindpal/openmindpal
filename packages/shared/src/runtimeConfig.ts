/**
 * runtimeConfig.ts — Runtime 配置解析器
 *
 * 优先级（高 → 低）：
 *   1. governance control plane 覆盖（DB 热配置）
 *   2. 环境变量
 *   3. 注册表默认值
 *
 * 用途：消除散落各处的 `process.env.XXX` 读取，
 *       统一通过此模块获取 runtime 级配置。
 */

import { CONFIG_REGISTRY, type ConfigEntry, parseConfigValue } from "./configRegistry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 配置值来源标记 */
export type RuntimeConfigSource = "governance" | "env" | "default";

/** 解析后的单条配置 */
export interface ResolvedConfig {
  envKey: string;
  value: string | number | boolean | string[] | undefined;
  source: RuntimeConfigSource;
}

/**
 * Governance control plane 提供的覆盖值。
 * key = envKey, value = 字符串形式的覆盖值。
 */
export type RuntimeConfigOverrides = Record<string, string>;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * 解析单条 runtime 配置。
 *
 * @param envKey   环境变量名
 * @param env      当前 process.env（或测试替身）
 * @param overrides governance 覆盖表
 */
export function resolveRuntimeConfig(
  envKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  overrides: RuntimeConfigOverrides = {},
): ResolvedConfig {
  const entry = CONFIG_REGISTRY.find((e) => e.envKey === envKey);
  if (!entry) {
    // 未注册的变量仍可读取 env，但标记来源为 env
    const raw = env[envKey];
    return { envKey, value: raw, source: "env" };
  }

  // 优先级 1: governance 覆盖
  if (entry.runtimeMutable && envKey in overrides) {
    return {
      envKey,
      value: parseConfigValue(entry, overrides[envKey]),
      source: "governance",
    };
  }

  // 优先级 2: 环境变量
  const envRaw = env[envKey];
  if (envRaw !== undefined && envRaw.trim() !== "") {
    return {
      envKey,
      value: parseConfigValue(entry, envRaw),
      source: "env",
    };
  }

  // 优先级 3: 默认值
  return {
    envKey,
    value: parseConfigValue(entry, entry.defaultValue),
    source: "default",
  };
}

/**
 * 批量解析所有 runtime-mutable 配置。
 *
 * @param env       当前 process.env
 * @param overrides governance 覆盖表
 */
export function resolveAllRuntimeConfigs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  overrides: RuntimeConfigOverrides = {},
): Map<string, ResolvedConfig> {
  const result = new Map<string, ResolvedConfig>();
  for (const entry of CONFIG_REGISTRY) {
    if (entry.level !== "runtime" || !entry.runtimeMutable) continue;
    result.set(entry.envKey, resolveRuntimeConfig(entry.envKey, env, overrides));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convenience typed accessors
// ---------------------------------------------------------------------------

/** 解析为 number，保证有 fallback */
export function resolveNumber(
  envKey: string,
  env?: Record<string, string | undefined>,
  overrides?: RuntimeConfigOverrides,
  fallback = 0,
): { value: number; source: RuntimeConfigSource } {
  const r = resolveRuntimeConfig(envKey, env, overrides);
  const n = typeof r.value === "number" ? r.value : Number(r.value);
  return { value: Number.isFinite(n) ? n : fallback, source: r.source };
}

/** 解析为 boolean */
export function resolveBoolean(
  envKey: string,
  env?: Record<string, string | undefined>,
  overrides?: RuntimeConfigOverrides,
  fallback = false,
): { value: boolean; source: RuntimeConfigSource } {
  const r = resolveRuntimeConfig(envKey, env, overrides);
  if (typeof r.value === "boolean") return { value: r.value, source: r.source };
  if (typeof r.value === "string") {
    const v = r.value.trim().toLowerCase();
    return { value: v === "1" || v === "true" || v === "yes", source: r.source };
  }
  return { value: fallback, source: r.source };
}

/** 解析为 string */
export function resolveString(
  envKey: string,
  env?: Record<string, string | undefined>,
  overrides?: RuntimeConfigOverrides,
  fallback = "",
): { value: string; source: RuntimeConfigSource } {
  const r = resolveRuntimeConfig(envKey, env, overrides);
  return { value: typeof r.value === "string" ? r.value : String(r.value ?? fallback), source: r.source };
}
