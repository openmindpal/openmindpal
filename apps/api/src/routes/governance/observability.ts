import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getObservabilitySummary, getAgentOSOperationsMetrics, checkArchitectureQualityAlerts, getRuntimeDegradationStats } from "../../modules/governance/observabilityRepo";

export const governanceObservabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/observability/summary", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "summary" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    const window = q.window ?? "1h";
    const out = await getObservabilitySummary({ pool: app.db as any, tenantId: subject.tenantId, window });
    req.ctx.audit!.outputDigest = { window, routes: out.routes.length, sync: out.sync.length, topErrors: out.topErrors.length };
    return out;
  });

  // P2-15: Agent OS 运营指标
  app.get("/governance/observability/operations", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "operations" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getAgentOSOperationsMetrics({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });

  // P2-15.4: 架构质量告警
  app.get("/governance/observability/quality-alerts", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "quality_alerts" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return checkArchitectureQualityAlerts({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });

  // P1-11.4: 运行时降级统计
  app.get("/governance/observability/degradation-stats", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "degradation_stats" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getRuntimeDegradationStats({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });
};

