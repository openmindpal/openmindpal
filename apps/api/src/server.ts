import Fastify from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { ZodError } from "zod";
import websocket from "@fastify/websocket";
import type { ApiConfig } from "./config";
import { Errors, isAppError } from "./lib/errors";
import { createRedisClient } from "./modules/redis/client";
import { auditRoutes } from "./routes/audit";
import { entityRoutes } from "./routes/entities";
import { effectiveSchemaRoutes } from "./routes/effectiveSchema";
import { healthRoutes } from "./routes/health";
import { jobRoutes } from "./routes/jobs";
import { meRoutes } from "./routes/me";
import { schemaRoutes } from "./routes/schemas";
import { toolRoutes } from "./routes/tools";
import { secretRoutes } from "./routes/secrets";
import { governanceRoutes } from "./routes/governance";
import { runRoutes } from "./routes/runs";
import { policySnapshotRoutes } from "./routes/policySnapshots";
import { rbacRoutes } from "./routes/rbac";
import { approvalRoutes } from "./routes/approvals";
import { settingsRoutes } from "./routes/settings";
import { authTokenRoutes } from "./routes/authTokens";
import { keyringRoutes } from "./routes/keyring";
import { metricsRoutes } from "./routes/metrics";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { skillLifecycleRoutes } from "./routes/extended";
import { getBuiltinSkills, validateSkillDependencies, isBuiltinSkillRegistrySealed, runStartupConsistencyCheck } from "./lib/skillPlugin";
import { initBuiltinSkills } from "./skills/registry";
import { collectCollabBacklogMetrics } from "./modules/metrics/collabBacklog";
import { createMetricsRegistry } from "./modules/metrics/metrics";
import { dispatchAuditOutboxBatch } from "./modules/audit/outboxRepo";
import { requestContextPlugin } from "./plugins/requestContext";
import { authenticationPlugin } from "./plugins/authentication";
import { preferencesPlugin } from "./plugins/preferences";
import { auditContextPlugin } from "./plugins/auditContext";
import { idempotencyKeyPlugin } from "./plugins/idempotencyKey";
import { dlpPlugin } from "./plugins/dlp";
import { auditPlugin } from "./plugins/audit";
import { metricsPlugin } from "./plugins/metrics";
import { autoDiscoverAndRegisterTools } from "./modules/tools/toolAutoDiscovery";

export function buildServer(cfg: ApiConfig, deps: { db: Pool; queue: Queue }) {
  const app = Fastify({ logger: true });
  app.decorate("db", deps.db);
  app.decorate("queue", deps.queue);
  app.decorate("redis", createRedisClient(cfg));
  app.decorate("cfg", cfg);
  app.decorate("metrics", createMetricsRegistry());
  app.register(websocket);

  // NOTE: autoDiscoverAndRegisterTools is now called after initBuiltinSkills() to ensure
  // the built-in skill registry is sealed before tool discovery runs.
  const auditOutboxEnabled = process.env.AUDIT_OUTBOX_DISPATCHER === "0" ? false : true;
  const auditOutboxIntervalMs = Math.max(250, Number(process.env.AUDIT_OUTBOX_INTERVAL_MS ?? "1000") || 1000);
  const auditOutboxBatch = Math.max(1, Math.min(200, Number(process.env.AUDIT_OUTBOX_BATCH ?? "50") || 50));
  let lastOutboxBacklogAtMs = 0;
  const auditOutboxTimer =
    auditOutboxEnabled
      ? setInterval(() => {
          dispatchAuditOutboxBatch({ pool: app.db, limit: auditOutboxBatch })
            .then((r) => {
              app.metrics.incAuditOutboxDispatch({ result: "ok" }, r.ok);
              app.metrics.incAuditOutboxDispatch({ result: "failed" }, r.failed);
            })
            .catch((e: any) => {
              console.warn("[server] audit outbox dispatch failed", { error: String(e?.message ?? e) });
            });
          const now = Date.now();
          const interval = Math.max(1000, Number(process.env.AUDIT_OUTBOX_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
          if (now - lastOutboxBacklogAtMs >= interval) {
            lastOutboxBacklogAtMs = now;
            app.db
              .query("SELECT status, COUNT(*)::int AS c FROM audit_outbox GROUP BY status")
              .then((res) => {
                const map = new Map<string, number>();
                for (const row of res.rows) map.set(String((row as any).status), Number((row as any).c ?? 0));
                const statuses = ["queued", "processing", "succeeded", "failed"];
                for (const s of statuses) app.metrics.setAuditOutboxBacklog({ status: s, count: map.get(s) ?? 0 });
                /* P1-2: outbox backlog 告警阈值 */
                const outboxThreshold = Math.max(1, Number(process.env.ALERT_OUTBOX_BACKLOG_THRESHOLD ?? "500") || 500);
                const deadletterThreshold = Math.max(1, Number(process.env.ALERT_OUTBOX_DEADLETTER_THRESHOLD ?? "10") || 10);
                const totalPending = (map.get("queued") ?? 0) + (map.get("processing") ?? 0) + (map.get("failed") ?? 0);
                const deadletterCount = map.get("deadletter") ?? 0;
                if (totalPending > outboxThreshold) {
                  console.error("[ALERT] audit_outbox_backlog exceeded threshold", { totalPending, threshold: outboxThreshold });
                  app.metrics.incAlertFired({ alert: "outbox_backlog" });
                }
                if (deadletterCount > deadletterThreshold) {
                  console.error("[ALERT] audit_outbox_deadletter exceeded threshold", { deadletterCount, threshold: deadletterThreshold });
                  app.metrics.incAlertFired({ alert: "outbox_deadletter" });
                }
              })
              .catch((e: any) => {
                console.warn("[server] audit outbox backlog query failed", { error: String(e?.message ?? e) });
              });
          }
        }, auditOutboxIntervalMs)
      : null;
  if (auditOutboxTimer) auditOutboxTimer.unref();

  const queueBacklogIntervalMs = Math.max(1000, Number(process.env.WORKFLOW_QUEUE_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const canReadQueueCounts = Boolean(app.queue && typeof (app.queue as any).getJobCounts === "function");
  const queueBacklogTimer = canReadQueueCounts
    ? setInterval(() => {
        (app.queue as any)
          .getJobCounts("waiting", "active", "delayed", "failed")
          .then((c: any) => {
            const statuses = ["waiting", "active", "delayed", "failed"] as const;
            for (const s of statuses) app.metrics.setWorkflowQueueBacklog({ status: s, count: Number(c?.[s] ?? 0) });
            /* P1-2: queue backlog 告警阈值 */
            const queueThreshold = Math.max(1, Number(process.env.ALERT_QUEUE_BACKLOG_THRESHOLD ?? "1000") || 1000);
            const totalQueue = Number(c?.waiting ?? 0) + Number(c?.active ?? 0) + Number(c?.delayed ?? 0);
            if (totalQueue > queueThreshold) {
              console.error("[ALERT] workflow_queue_backlog exceeded threshold", { totalQueue, threshold: queueThreshold });
              app.metrics.incAlertFired({ alert: "queue_backlog" });
            }
          })
          .catch((e: any) => {
            console.warn("[server] queue backlog query failed", { error: String(e?.message ?? e) });
          });
      }, queueBacklogIntervalMs)
    : null;
  if (queueBacklogTimer) queueBacklogTimer.unref();

  const collabBacklogIntervalMs = Math.max(1000, Number(process.env.COLLAB_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const collabBacklogTimer = setInterval(() => {
    collectCollabBacklogMetrics(app.db, app.metrics).catch(() => {});
  }, collabBacklogIntervalMs);
  collabBacklogTimer.unref();

  const workerMetricsIntervalMs = Math.max(1000, Number(process.env.WORKER_METRICS_INTERVAL_MS ?? "10000") || 10000);
  const workerMetricsTimer = setInterval(() => {
    Promise.all([
      app.redis.get("worker:heartbeat:ts"),
      app.redis.get("worker:workflow:step:success"),
      app.redis.get("worker:workflow:step:error"),
      app.redis.get("worker:tool_execute:success"),
      app.redis.get("worker:tool_execute:error"),
    ])
      .then(([hb, ok, err, toolOk, toolErr]) => {
        const ts = hb ? Number(hb) : NaN;
        const ageSec = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 1000) : 1e9;
        app.metrics.setWorkerHeartbeatAgeSeconds({ worker: "workflow", ageSeconds: ageSec });
        app.metrics.setWorkerWorkflowStepCount({ result: "success", count: ok ? Number(ok) : 0 });
        app.metrics.setWorkerWorkflowStepCount({ result: "error", count: err ? Number(err) : 0 });
        app.metrics.setWorkerToolExecuteCount({ result: "success", count: toolOk ? Number(toolOk) : 0 });
        app.metrics.setWorkerToolExecuteCount({ result: "error", count: toolErr ? Number(toolErr) : 0 });
      })
      .catch(() => {
      });
  }, workerMetricsIntervalMs);
  workerMetricsTimer.unref();

  const corsAllowedMethods = "GET,POST,PUT,DELETE,OPTIONS";
  const corsAllowedHeaders =
    "content-type,authorization,x-tenant-id,x-space-id,x-user-locale,x-space-locale,x-tenant-locale,x-schema-name,x-trace-id,idempotency-key";

  function isAllowedOrigin(origin: string) {
    const allowed = cfg.cors?.allowedOrigins ?? [];
    return allowed.includes(origin);
  }

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin as string | undefined;
    if (!origin) return;

    if (isAllowedOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "origin");
    }

    if (req.method === "OPTIONS") {
      if (isAllowedOrigin(origin)) {
        reply.header("access-control-allow-methods", corsAllowedMethods);
        reply.header("access-control-allow-headers", corsAllowedHeaders);
        reply.header("access-control-max-age", "600");
      }
      reply.code(204).send();
      return;
    }
  });

  app.addHook("onClose", async () => {
    if (auditOutboxTimer) clearInterval(auditOutboxTimer);
    if (queueBacklogTimer) clearInterval(queueBacklogTimer);
    clearInterval(workerMetricsTimer);
    await app.redis.quit();
  });

  app.setErrorHandler(async (err, req, reply) => {
    req.log.error({ err, traceId: req.ctx?.traceId, requestId: req.ctx?.requestId }, "request_error");
    const pgCode = typeof (err as any)?.code === "string" ? String((err as any).code) : "";
    const appErr =
      err instanceof ZodError
        ? Errors.badRequest("参数校验失败")
        : isAppError(err)
          ? err
          : pgCode === "22P02"
            ? Errors.badRequest("ID 格式非法")
            : pgCode === "23503"
              ? Errors.badRequest("关联记录不存在")
              : pgCode === "42P01" || pgCode === "42703"
                ? Errors.serviceNotReady("数据库结构未初始化或版本不匹配")
                : Errors.internal();
    const status = appErr.httpStatus;
    const auditSafetySummary = (() => {
      const digest = req.ctx?.audit?.outputDigest as any;
      if (!digest || typeof digest !== "object") return undefined;
      const ss = digest.safetySummary;
      if (!ss || typeof ss !== "object" || Array.isArray(ss)) return undefined;
      return ss;
    })();
    const payload: any = {
      errorCode: appErr.errorCode,
      message: appErr.messageI18n,
      traceId: req.ctx?.traceId,
      requestId: req.ctx?.requestId,
    };
    if (auditSafetySummary) payload.safetySummary = auditSafetySummary;

    return reply.status(status).send(payload);
  });

  app.register(async (scoped) => {
    await requestContextPlugin(scoped, { platformLocale: cfg.platformLocale });
    await authenticationPlugin(scoped, {});
    await preferencesPlugin(scoped, {});
    await auditContextPlugin(scoped, {});
    await idempotencyKeyPlugin(scoped, {});
    await dlpPlugin(scoped, {});
    await auditPlugin(scoped, {});
    await metricsPlugin(scoped, {});

    scoped.register(healthRoutes);
    scoped.register(diagnosticsRoutes);
    scoped.register(metricsRoutes);
    scoped.register(meRoutes);
    scoped.register(authTokenRoutes);
    // ── Core Kernel Routes (primitives that remain in kernel) ────────
    scoped.register(auditRoutes);
    scoped.register(entityRoutes);
    scoped.register(effectiveSchemaRoutes);
    scoped.register(jobRoutes);
    scoped.register(schemaRoutes);
    scoped.register(toolRoutes);
    scoped.register(secretRoutes);
    scoped.register(governanceRoutes);
    scoped.register(runRoutes);
    scoped.register(policySnapshotRoutes);
    scoped.register(rbacRoutes);
    scoped.register(approvalRoutes);
    scoped.register(settingsRoutes);
    scoped.register(keyringRoutes);
    scoped.register(skillLifecycleRoutes);

    // ── Built-in Skill Routes (auto-discovered) ────────────────────
    initBuiltinSkills();

    // Run comprehensive startup consistency check
    const startupCheck = runStartupConsistencyCheck();
    if (startupCheck.warnings.length > 0) {
      for (const w of startupCheck.warnings) app.log.warn(w);
    }
    if (!startupCheck.ok) {
      for (const e of startupCheck.errors) app.log.error(e);
      throw new Error(`[startup] Skill registry consistency check failed: ${startupCheck.errors.join("; ")}`);
    }
    app.log.info(startupCheck.summary, "[startup] Skill registry consistency check passed");
    const registeredSkills: string[] = [];
    for (const [name, skill] of getBuiltinSkills()) {
      scoped.register(skill.routes);
      registeredSkills.push(name);
    }
    app.log.info({ registeredSkills: registeredSkills.length, skills: registeredSkills }, "[startup] Built-in skills registered");

    // Auto-discover and register tools (now that builtin skills are registered and sealed)
    try {
      const discovery = await autoDiscoverAndRegisterTools(app.db);
      app.log.info({ registered: discovery.registered, skipped: discovery.skipped }, "[startup] Tool discovery completed");
    } catch (e: any) {
      app.log.error({ err: e }, "[startup] Tool discovery failed (non-fatal)");
    }
  });

  return app;
}
