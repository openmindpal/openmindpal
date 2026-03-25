/**
 * Degradation Chain — architecture section 16.2
 *
 * When the primary capability fails, the system falls back through a chain:
 *   Model Chat -> Knowledge Retrieval -> Cached Execution -> Static Output
 *
 * Each tier has a health check and the chain auto-advances on failure.
 */

import type { RedisClient } from "../../../modules/redis/client";

export type DegradationTier = "model" | "retrieval" | "execution" | "static_output";

export type TierHealthStatus = {
  tier: DegradationTier;
  healthy: boolean;
  lastCheckedAt: number;
  failCount: number;
  errorSample?: string;
};

type DegradationChainConfig = {
  maxFailures: number;
  recoveryWindowMs: number;
  tierOrder: DegradationTier[];
};

const DEFAULT_CONFIG: DegradationChainConfig = {
  maxFailures: 3,
  recoveryWindowMs: 60_000,
  tierOrder: ["model", "retrieval", "execution", "static_output"],
};

/* --- In-memory tier health state --- */

const tierHealth = new Map<string, TierHealthStatus>();

function tierKey(tenantId: string, tier: DegradationTier) {
  return `degrade:${tenantId}:${tier}`;
}

export function getTierHealth(tenantId: string, tier: DegradationTier): TierHealthStatus {
  const key = tierKey(tenantId, tier);
  return tierHealth.get(key) ?? { tier, healthy: true, lastCheckedAt: 0, failCount: 0 };
}

export function recordTierFailure(tenantId: string, tier: DegradationTier, error?: string): TierHealthStatus {
  const key = tierKey(tenantId, tier);
  const prev = getTierHealth(tenantId, tier);
  const now = Date.now();

  /* Reset fail count if outside recovery window */
  const failCount = (now - prev.lastCheckedAt > DEFAULT_CONFIG.recoveryWindowMs) ? 1 : prev.failCount + 1;
  const healthy = failCount < DEFAULT_CONFIG.maxFailures;

  const status: TierHealthStatus = {
    tier,
    healthy,
    lastCheckedAt: now,
    failCount,
    errorSample: error?.slice(0, 200),
  };
  tierHealth.set(key, status);
  return status;
}

export function recordTierSuccess(tenantId: string, tier: DegradationTier): TierHealthStatus {
  const key = tierKey(tenantId, tier);
  const status: TierHealthStatus = {
    tier,
    healthy: true,
    lastCheckedAt: Date.now(),
    failCount: 0,
  };
  tierHealth.set(key, status);
  return status;
}

/* --- Resolve effective tier --- */

export function resolveEffectiveTier(tenantId: string, config?: Partial<DegradationChainConfig>): {
  activeTier: DegradationTier;
  skippedTiers: DegradationTier[];
  healthMap: Record<DegradationTier, TierHealthStatus>;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const skipped: DegradationTier[] = [];
  const healthMap = {} as Record<DegradationTier, TierHealthStatus>;

  for (const tier of cfg.tierOrder) {
    const h = getTierHealth(tenantId, tier);
    healthMap[tier] = h;
    if (h.healthy) {
      return { activeTier: tier, skippedTiers: skipped, healthMap };
    }
    skipped.push(tier);
  }

  /* All tiers unhealthy — fallback to last tier (static output) */
  const lastTier = cfg.tierOrder[cfg.tierOrder.length - 1];
  return { activeTier: lastTier, skippedTiers: skipped.filter((t) => t !== lastTier), healthMap };
}

/* --- Redis-backed persistence for cluster mode --- */

export async function persistTierHealth(redis: RedisClient, tenantId: string, tier: DegradationTier) {
  const h = getTierHealth(tenantId, tier);
  const key = `degradation:health:${tenantId}:${tier}`;
  await redis.set(key, JSON.stringify(h), "EX", 120);
}

export async function loadTierHealthFromRedis(redis: RedisClient, tenantId: string, tier: DegradationTier): Promise<TierHealthStatus | null> {
  const key = `degradation:health:${tenantId}:${tier}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TierHealthStatus;
  } catch {
    return null;
  }
}

/* --- Static output fallback --- */

export function buildStaticFallbackOutput(params: { locale: string; originalError?: string }): {
  replyText: Record<string, string>;
  degraded: true;
  tier: "static_output";
} {
  return {
    replyText: {
      "zh-CN": "系统暂时繁忙，请稍后再试。您的请求已记录，我们会尽快恢复服务。",
      "en-US": "The system is temporarily busy. Please try again later. Your request has been recorded.",
    },
    degraded: true,
    tier: "static_output",
  };
}
