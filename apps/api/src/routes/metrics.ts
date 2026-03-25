import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/metrics", async (req, reply) => {
    setAuditContext(req, { resourceType: "metrics", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "metrics", action: "read" });
    const text = app.metrics.renderPrometheus();
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(text);
  });
};

