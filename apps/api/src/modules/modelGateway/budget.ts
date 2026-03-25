import type { RedisClient } from "../redis/client";

const incrByScript = `
  local key = KEYS[1]
  local ttlMs = tonumber(ARGV[1])
  local delta = tonumber(ARGV[2])
  local v = redis.call('INCRBY', key, delta)
  if v == delta then
    redis.call('PEXPIRE', key, ttlMs)
  end
  return v
`;

function yyyymmddUtc(nowMs: number) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function tokenBudgetKey(params: { tenantId: string; scopeType: "tenant" | "space"; scopeId: string; purpose: string; nowMs?: number }) {
  const now = params.nowMs ?? Date.now();
  const day = yyyymmddUtc(now);
  return `budget:model_tokens:${params.tenantId}:${params.scopeType}:${params.scopeId}:${params.purpose}:${day}`;
}

export async function getTokenBudgetUsed(params: { redis: RedisClient; key: string }) {
  const v = await params.redis.get(params.key);
  const n = v == null ? 0 : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function incrTokenBudgetUsed(params: { redis: RedisClient; key: string; delta: number; ttlMs: number }) {
  const d = Math.max(0, Math.floor(params.delta));
  if (!d) return getTokenBudgetUsed({ redis: params.redis, key: params.key });
  const v = (await params.redis.eval(incrByScript, 1, params.key, String(params.ttlMs), String(d))) as number;
  return typeof v === "number" && Number.isFinite(v) ? v : getTokenBudgetUsed({ redis: params.redis, key: params.key });
}

