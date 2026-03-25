import type { RedisClient } from "../../../modules/redis/client";

const incrScript = `
  local key = KEYS[1]
  local windowMs = tonumber(ARGV[1])
  local v = redis.call('INCR', key)
  if v == 1 then
    redis.call('PEXPIRE', key, windowMs)
  end
  return v
`;

function scopeKeyPart(scope: { scopeType: string; scopeId: string }) {
  return `${scope.scopeType}:${scope.scopeId}`;
}

export async function isCircuitOpen(params: { redis: RedisClient; tenantId: string; scope: { scopeType: string; scopeId: string }; modelRef: string }) {
  const key = `cb:model_chat:open:${params.tenantId}:${scopeKeyPart(params.scope)}:${params.modelRef}`;
  const v = await params.redis.get(key);
  return Boolean(v);
}

export async function recordCircuitFailure(params: {
  redis: RedisClient;
  tenantId: string;
  scope: { scopeType: string; scopeId: string };
  modelRef: string;
  windowSec: number;
  failThreshold: number;
  openSec: number;
}) {
  const failKey = `cb:model_chat:fail:${params.tenantId}:${scopeKeyPart(params.scope)}:${params.modelRef}`;
  const count = (await params.redis.eval(incrScript, 1, failKey, String(params.windowSec * 1000))) as number;
  if (count >= params.failThreshold) {
    const openKey = `cb:model_chat:open:${params.tenantId}:${scopeKeyPart(params.scope)}:${params.modelRef}`;
    await params.redis.set(openKey, "1", "EX", params.openSec);
  }
  return { count };
}

