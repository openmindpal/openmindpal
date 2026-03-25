import Redis from "ioredis";
import type { ApiConfig } from "../../config";

export type RedisClient = Redis;

export function createRedisClient(cfg: ApiConfig) {
  return new Redis({
    host: cfg.redis.host,
    port: cfg.redis.port,
    maxRetriesPerRequest: null,
  });
}

