import type { RedisClient } from "../redis/client";

const script = `
  local key = KEYS[1]
  local windowMs = tonumber(ARGV[1])
  local v = redis.call('INCR', key)
  if v == 1 then
    redis.call('PEXPIRE', key, windowMs)
  end
  return v
`;

export async function checkTenantRateLimit(params: {
  redis: RedisClient;
  tenantId: string;
  rpm: number;
  nowMs?: number;
}) {
  const windowMs = 60_000;
  const key = `rl:model_chat:${params.tenantId}`;
  const count = (await params.redis.eval(script, 1, key, String(windowMs))) as number;
  return { allowed: count <= params.rpm, remaining: Math.max(0, params.rpm - count) };
}

export async function resetTenantRateLimit(redis: RedisClient) {
  let cursor = "0";
  do {
    const [next, keys] = (await redis.scan(cursor, "MATCH", "rl:model_chat:*", "COUNT", "200")) as unknown as [string, string[]];
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}
