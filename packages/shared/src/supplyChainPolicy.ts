/**
 * supplyChainPolicy.ts — 统一供应链治理判定
 *
 * 将散落在 API / Worker / Runner 中的信任门槛、隔离等级、
 * SBOM 验证、依赖扫描、降级判定统一到一个共享模块。
 *
 * 所有运行时应统一引用此模块，而不是各自重新解析 env。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 运行时隔离等级（从低到高） */
export type IsolationLevel = "process" | "container" | "remote";

/** 隔离等级排序（数字越大越高） */
const ISOLATION_ORDER: Record<IsolationLevel, number> = {
  process: 0,
  container: 1,
  remote: 2,
};

/** 依赖扫描/SBOM 检查模式 */
export type ScanMode = "off" | "audit_only" | "deny";

/** 降级策略 */
export type DegradationStrategy = "allow" | "deny" | "audit";

/** 供应链策略配置结构 */
export interface SupplyChainPolicyConfig {
  /** 是否强制签名验证 */
  trustEnforced: boolean;
  /** 依赖扫描模式 */
  depScanMode: ScanMode;
  /** SBOM 验证模式 */
  sbomMode: ScanMode;
  /** 最低隔离等级 */
  minIsolation: IsolationLevel;
  /** 是否允许不安全模式 (绕过隔离) */
  unsafeAllowed: boolean;
  /** 降级策略: container 不可用时是否回退 process */
  degradationStrategy: DegradationStrategy;
  /** 是否生产环境 */
  isProduction: boolean;
}

/** 信任验证结果 */
export interface TrustCheckResult {
  ok: boolean;
  enforced: boolean;
  status: string;
}

/** 依赖扫描验证结果 */
export interface ScanCheckResult {
  ok: boolean;
  enforced: boolean;
  mode: ScanMode;
  status: string;
  vulnerabilities?: { critical: number; high: number };
}

/** SBOM 验证结果 */
export interface SbomCheckResult {
  ok: boolean;
  enforced: boolean;
  mode: ScanMode;
  status: string;
  hasDigest: boolean;
}

/** 隔离等级判定结果 */
export interface IsolationDecision {
  /** 选定的隔离等级 */
  level: IsolationLevel;
  /** 是否发生了降级 */
  degraded: boolean;
  /** 降级原因 */
  degradationReason?: string;
  /** 是否被策略拒绝 */
  denied: boolean;
  /** 拒绝原因 */
  deniedReason?: string;
}

// ---------------------------------------------------------------------------
// Policy resolution from env
// ---------------------------------------------------------------------------

/**
 * 从环境变量解析完整的供应链策略配置。
 * 这是唯一应该解析 env 的地方。
 */
export function resolveSupplyChainPolicy(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SupplyChainPolicyConfig {
  const isProduction = env.NODE_ENV === "production";

  // trust
  const trustRaw = String(env.SKILL_TRUST_ENFORCE ?? "").trim().toLowerCase();
  const trustEnforced = isProduction && !(trustRaw === "0" || trustRaw === "false" || trustRaw === "no");

  // dep scan
  const depScanRaw = String(env.SKILL_DEP_SCAN_MODE ?? "").trim().toLowerCase();
  const depScanMode = parseScanMode(depScanRaw, isProduction);

  // sbom
  const sbomRaw = String(env.SKILL_SBOM_MODE ?? "").trim().toLowerCase();
  const sbomMode = parseScanMode(sbomRaw, isProduction);

  // isolation
  const minIsoRaw = String(env.SKILL_ISOLATION_MIN ?? "").trim().toLowerCase();
  const minIsolation: IsolationLevel =
    minIsoRaw === "remote" ? "remote"
    : minIsoRaw === "container" ? "container"
    : isProduction ? "container"
    : "process";

  // unsafe
  const unsafeRaw = String(env.SKILL_RUNTIME_UNSAFE_ALLOW ?? "").trim().toLowerCase();
  const unsafeAllowed = unsafeRaw === "1" || unsafeRaw === "true" || unsafeRaw === "yes";

  // degradation
  const fallbackRaw = String(env.SKILL_RUNTIME_CONTAINER_FALLBACK ?? "").trim().toLowerCase();
  const degradationStrategy: DegradationStrategy =
    (fallbackRaw === "0" || fallbackRaw === "false" || fallbackRaw === "no")
      ? "deny"
      : isProduction ? "deny" : "audit";

  return {
    trustEnforced,
    depScanMode,
    sbomMode,
    minIsolation,
    unsafeAllowed,
    degradationStrategy,
    isProduction,
  };
}

function parseScanMode(raw: string, isProduction: boolean): ScanMode {
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no" || raw === "skip") return "off";
  if (raw === "audit_only") return "audit_only";
  if (raw === "deny") return "deny";
  return isProduction ? "deny" : "audit_only";
}

// ---------------------------------------------------------------------------
// Trust check
// ---------------------------------------------------------------------------

/**
 * 统一的信任签名验证判定。
 */
export function checkTrust(
  policy: SupplyChainPolicyConfig,
  trustSummary: { status?: string } | null | undefined,
): TrustCheckResult {
  const status = String(trustSummary?.status ?? "unknown").toLowerCase();
  if (status === "untrusted") return { ok: false, enforced: policy.trustEnforced, status };
  if (status === "trusted") return { ok: true, enforced: policy.trustEnforced, status };
  // unknown/missing: 只有 enforced 时拒绝
  return { ok: !policy.trustEnforced, enforced: policy.trustEnforced, status };
}

// ---------------------------------------------------------------------------
// Dependency scan check
// ---------------------------------------------------------------------------

/**
 * 统一的依赖扫描判定。
 */
export function checkDependencyScan(
  policy: SupplyChainPolicyConfig,
  scanSummary: { status?: string; vulnerabilities?: { critical?: number; high?: number } } | null | undefined,
): ScanCheckResult {
  const mode = policy.depScanMode;
  const enforced = mode === "deny";
  const status = String(scanSummary?.status ?? "").toLowerCase();
  const critical = Number(scanSummary?.vulnerabilities?.critical ?? 0) || 0;
  const high = Number(scanSummary?.vulnerabilities?.high ?? 0) || 0;

  if (!enforced) return { ok: true, enforced, mode, status: status || "skipped", vulnerabilities: { critical, high } };
  if (status !== "ok") return { ok: false, enforced, mode, status: status || "missing", vulnerabilities: { critical, high } };
  if (critical > 0 || high > 0) return { ok: false, enforced, mode, status, vulnerabilities: { critical, high } };
  return { ok: true, enforced, mode, status, vulnerabilities: { critical, high } };
}

// ---------------------------------------------------------------------------
// SBOM check
// ---------------------------------------------------------------------------

/**
 * 统一的 SBOM 验证判定。
 */
export function checkSbom(
  policy: SupplyChainPolicyConfig,
  sbomSummary: { status?: string } | null | undefined,
  sbomDigest: string | null | undefined,
): SbomCheckResult {
  const mode = policy.sbomMode;
  const enforced = mode === "deny";
  const status = String(sbomSummary?.status ?? "").toLowerCase();
  const hasDigest = typeof sbomDigest === "string" && sbomDigest.length > 0;

  if (!enforced) return { ok: true, enforced, mode, status: status || "unknown", hasDigest };
  if (status === "ok" && hasDigest) return { ok: true, enforced, mode, status, hasDigest };
  return { ok: false, enforced, mode, status: status || "missing", hasDigest };
}

// ---------------------------------------------------------------------------
// Isolation level decision
// ---------------------------------------------------------------------------

/**
 * 判定请求的隔离等级是否满足策略要求。
 *
 * @param policy        供应链策略
 * @param requested     请求的运行时后端
 * @param available     可用的运行时后端集合 (e.g. ["process", "container"])
 */
export function decideIsolation(
  policy: SupplyChainPolicyConfig,
  requested: IsolationLevel | "auto",
  available: IsolationLevel[] = ["process", "container", "remote"],
): IsolationDecision {
  const minOrder = ISOLATION_ORDER[policy.minIsolation];
  const availableSet = new Set(available);

  // unsafe mode bypasses all checks
  if (policy.unsafeAllowed) {
    const level = requested === "auto" ? "process" : requested;
    return { level, degraded: false, denied: false };
  }

  // auto: pick highest available that meets minimum
  if (requested === "auto") {
    // prefer from high to low
    for (const candidate of ["remote", "container", "process"] as IsolationLevel[]) {
      if (availableSet.has(candidate) && ISOLATION_ORDER[candidate] >= minOrder) {
        return { level: candidate, degraded: false, denied: false };
      }
    }
    // nothing meets minimum — try degradation
    return handleDegradation(policy, available, availableSet);
  }

  // explicit request
  if (ISOLATION_ORDER[requested] >= minOrder) {
    if (availableSet.has(requested)) {
      return { level: requested, degraded: false, denied: false };
    }
    // requested not available — try degradation
    return handleDegradation(policy, available, availableSet);
  }

  // requested is below minimum — check degradation
  return handleDegradation(policy, available, availableSet);
}

function handleDegradation(
  policy: SupplyChainPolicyConfig,
  available: IsolationLevel[],
  availableSet: Set<IsolationLevel>,
): IsolationDecision {
  const minOrder = ISOLATION_ORDER[policy.minIsolation];

  // find best available below minimum
  let bestBelow: IsolationLevel | null = null;
  for (const candidate of ["container", "process"] as IsolationLevel[]) {
    if (availableSet.has(candidate)) {
      bestBelow = candidate;
      break;
    }
  }

  if (!bestBelow) {
    return {
      level: "process",
      degraded: false,
      denied: true,
      deniedReason: `no runtime available; minimum=${policy.minIsolation}`,
    };
  }

  if (policy.degradationStrategy === "deny") {
    return {
      level: bestBelow,
      degraded: false,
      denied: true,
      deniedReason: `${bestBelow} < minimum ${policy.minIsolation}; degradation denied in ${policy.isProduction ? "production" : "current"} mode`,
    };
  }

  // audit or allow: degrade with warning
  return {
    level: bestBelow,
    degraded: true,
    denied: false,
    degradationReason: `degraded from ${policy.minIsolation} to ${bestBelow} (strategy=${policy.degradationStrategy})`,
  };
}

// ---------------------------------------------------------------------------
// Convenience: full gate check
// ---------------------------------------------------------------------------

export interface SupplyChainGateResult {
  allowed: boolean;
  trust: TrustCheckResult;
  scan: ScanCheckResult;
  sbom: SbomCheckResult;
  isolation: IsolationDecision;
  violations: string[];
}

/**
 * 完整的供应链门控检查。
 * 返回综合结果，包含每项子检查和最终是否放行。
 */
export function supplyChainGate(params: {
  policy: SupplyChainPolicyConfig;
  trustSummary?: { status?: string } | null;
  scanSummary?: { status?: string; vulnerabilities?: { critical?: number; high?: number } } | null;
  sbomSummary?: { status?: string } | null;
  sbomDigest?: string | null;
  requestedIsolation?: IsolationLevel | "auto";
  availableRuntimes?: IsolationLevel[];
}): SupplyChainGateResult {
  const trust = checkTrust(params.policy, params.trustSummary);
  const scan = checkDependencyScan(params.policy, params.scanSummary);
  const sbom = checkSbom(params.policy, params.sbomSummary, params.sbomDigest);
  const isolation = decideIsolation(
    params.policy,
    params.requestedIsolation ?? "auto",
    params.availableRuntimes,
  );

  const violations: string[] = [];
  if (!trust.ok) violations.push(`trust:${trust.status}`);
  if (!scan.ok) violations.push(`dep_scan:${scan.status}`);
  if (!sbom.ok) violations.push(`sbom:${sbom.status}`);
  if (isolation.denied) violations.push(`isolation:${isolation.deniedReason}`);

  return {
    allowed: violations.length === 0,
    trust,
    scan,
    sbom,
    isolation,
    violations,
  };
}
