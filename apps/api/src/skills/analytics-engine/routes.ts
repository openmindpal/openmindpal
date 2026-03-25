import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import {
  createAnalyticsView,
  listAnalyticsViews,
  getAnalyticsView,
  deleteAnalyticsView,
  createMetricDefinition,
  listMetricDefinitions,
  createRefreshJob,
  listRefreshJobs,
  executeViewQuery,
} from "./modules/analyticsRepo";
import {
  listLazyMigrationLogs,
  getMigrationStats,
} from "../../modules/data/schemaLazyMigration";

export const analyticsApiRoutes: FastifyPluginAsync = async (app) => {
  // ─── Analytics Views ────────────────────────────────────────────────
  app.get("/analytics/views", async (req) => {
    setAuditContext(req, { resourceType: "analytics", action: "list_views" });
    const decision = await requirePermission({ req, resourceType: "analytics", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const views = await listAnalyticsViews({ pool: app.db, tenantId: subject.tenantId });
    return { views };
  });

  app.post("/analytics/views", async (req) => {
    setAuditContext(req, { resourceType: "analytics", action: "create_view" });
    const decision = await requirePermission({ req, resourceType: "analytics", action: "write" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const body = z.object({
      viewName: z.string().min(1),
      sourceSchema: z.string().min(1),
      sourceEntity: z.string().min(1),
      dimensions: z.array(z.any()).optional(),
      measures: z.array(z.any()).optional(),
      timeGranularity: z.string().optional(),
      filterExpr: z.any().optional(),
      refreshStrategy: z.enum(["full", "incremental", "manual"]).optional(),
      refreshCron: z.string().optional(),
    }).parse(req.body);
    const view = await createAnalyticsView({ pool: app.db, tenantId: subject.tenantId, ...body });
    req.ctx.audit!.outputDigest = { viewId: view.viewId };
    return { view };
  });

  app.get("/analytics/views/:viewId", async (req) => {
    const params = z.object({ viewId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "analytics", action: "get_view" });
    await requirePermission({ req, resourceType: "analytics", action: "read" });
    const subject = req.ctx.subject!;
    const view = await getAnalyticsView({ pool: app.db, tenantId: subject.tenantId, viewId: params.viewId });
    return { view };
  });

  app.delete("/analytics/views/:viewId", async (req) => {
    const params = z.object({ viewId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "analytics", action: "delete_view" });
    await requirePermission({ req, resourceType: "analytics", action: "write" });
    const subject = req.ctx.subject!;
    const ok = await deleteAnalyticsView({ pool: app.db, tenantId: subject.tenantId, viewId: params.viewId });
    return { ok };
  });

  // ─── Metrics ────────────────────────────────────────────────────────
  app.get("/analytics/metrics", async (req) => {
    setAuditContext(req, { resourceType: "analytics", action: "list_metrics" });
    await requirePermission({ req, resourceType: "analytics", action: "read" });
    const subject = req.ctx.subject!;
    const metrics = await listMetricDefinitions({ pool: app.db, tenantId: subject.tenantId });
    return { metrics };
  });

  app.post("/analytics/metrics", async (req) => {
    setAuditContext(req, { resourceType: "analytics", action: "create_metric" });
    await requirePermission({ req, resourceType: "analytics", action: "write" });
    const subject = req.ctx.subject!;
    const body = z.object({
      metricName: z.string().min(1),
      displayName: z.any().optional(),
      description: z.any().optional(),
      viewId: z.string().optional(),
      expression: z.string().min(1),
      dimensions: z.array(z.any()).optional(),
      unit: z.string().optional(),
    }).parse(req.body);
    const metric = await createMetricDefinition({ pool: app.db, tenantId: subject.tenantId, ...body });
    return { metric };
  });

  // ─── Refresh Jobs ───────────────────────────────────────────────────
  app.post("/analytics/views/:viewId/refresh", async (req) => {
    const params = z.object({ viewId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "analytics", action: "refresh" });
    await requirePermission({ req, resourceType: "analytics", action: "write" });
    const subject = req.ctx.subject!;
    const job = await createRefreshJob({ pool: app.db, tenantId: subject.tenantId, viewId: params.viewId });
    return { job };
  });

  app.get("/analytics/refresh-jobs", async (req) => {
    setAuditContext(req, { resourceType: "analytics", action: "list_jobs" });
    await requirePermission({ req, resourceType: "analytics", action: "read" });
    const subject = req.ctx.subject!;
    const query = z.object({ viewId: z.string().optional() }).parse(req.query);
    const jobs = await listRefreshJobs({ pool: app.db, tenantId: subject.tenantId, viewId: query.viewId ?? "" });
    return { jobs };
  });

  // ─── Query Execution ──────────────────────────────────────────────
  app.post("/analytics/views/:viewId/query", async (req) => {
    const params = z.object({ viewId: z.string().min(1) }).parse(req.params);
    const body = z.object({
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      filters: z.record(z.string(), z.any()).optional(),
    }).parse(req.body ?? {});
    setAuditContext(req, { resourceType: "analytics", action: "query" });
    await requirePermission({ req, resourceType: "analytics", action: "read" });
    const subject = req.ctx.subject!;
    const view = await getAnalyticsView({ pool: app.db, tenantId: subject.tenantId, viewId: params.viewId });
    if (!view) return { errorCode: "NOT_FOUND", message: { "zh-CN": "视图不存在", "en-US": "View not found" } };
    const result = await executeViewQuery({ pool: app.db, view, tenantId: subject.tenantId, limit: body.limit, offset: body.offset, filters: body.filters });
    req.ctx.audit!.outputDigest = { viewId: params.viewId, rowCount: result.rowCount, truncated: result.truncated };
    return result;
  });

  // ─── Schema Lazy Migration Logs ─────────────────────────────────────
  app.get("/analytics/migration-logs", async (req) => {
    setAuditContext(req, { resourceType: "schema_migration", action: "list" });
    await requirePermission({ req, resourceType: "schema", action: "read" });
    const subject = req.ctx.subject!;
    const query = z.object({
      schemaName: z.string().optional(),
      recordId: z.string().optional(),
      limit: z.coerce.number().min(1).max(500).optional(),
    }).parse(req.query);
    const logs = await listLazyMigrationLogs({ pool: app.db, tenantId: subject.tenantId, ...query });
    return { logs };
  });

  app.get("/analytics/migration-stats/:schemaName", async (req) => {
    const params = z.object({ schemaName: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "schema_migration", action: "stats" });
    await requirePermission({ req, resourceType: "schema", action: "read" });
    const subject = req.ctx.subject!;
    const stats = await getMigrationStats({ pool: app.db, tenantId: subject.tenantId, schemaName: params.schemaName });
    return stats;
  });
};
