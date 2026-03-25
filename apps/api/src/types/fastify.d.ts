import "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { RedisClient } from "../modules/redis/client";
import type { ApiConfig } from "../config";
import type { MetricsRegistry } from "../modules/metrics/metrics";

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
    queue: Queue;
    redis: RedisClient;
    cfg: ApiConfig;
    metrics: MetricsRegistry;
  }

  interface FastifyRequest {
    ctx: {
      traceId: string;
      requestId: string;
      locale: string;
      subject?: {
        subjectId: string;
        tenantId: string;
        spaceId?: string;
      };
      audit?: {
        resourceType?: string;
        action?: string;
        toolRef?: string;
        workflowRef?: string;
        idempotencyKey?: string;
        policyDecision?: unknown;
        inputDigest?: unknown;
        outputDigest?: unknown;
        errorCategory?: string;
        startedAtMs?: number;
        lastError?: unknown;
        skipAuditWrite?: boolean;
        requireOutbox?: boolean;
        outboxEnqueued?: boolean;
      };
    };
  }
}
