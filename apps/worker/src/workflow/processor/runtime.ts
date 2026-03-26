/**
 * runtime.ts — Worker 运行时模块 (已迁移至 @openslin/shared)
 *
 * 此文件保留以保持向后兼容，实际实现已统一到共享层。
 * @see packages/shared/src/runtime.ts
 */

// 统一从 @openslin/shared 重新导出所有内容
export {
  isPlainObject,
  normalizeLimits,
  normalizeNetworkPolicy,
  isAllowedHost,
  isAllowedEgress,
  runtimeFetch,
  withConcurrency,
  withTimeout,
} from "@openslin/shared";

export type {
  RuntimeLimits,
  NetworkPolicyRule,
  NetworkPolicy,
  EgressEvent,
  EgressCheck,
} from "@openslin/shared";

