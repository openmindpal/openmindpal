import type { FastifyPluginAsync } from "fastify";

export const metricsPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onResponse", async (req, reply) => {
    const startedAtMs = req.ctx.audit?.startedAtMs ?? Date.now();
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const method = req.method;
    const route =
      ((req as any).routeOptions?.url as string | undefined) ??
      ((req as any).routerPath as string | undefined) ??
      "unmatched";
    app.metrics.observeRequest({ method, route, statusCode: reply.statusCode, latencyMs });

    const pd = req.ctx.audit?.policyDecision as any;
    if (reply.statusCode === 403 && pd && String(pd.decision ?? "") === "deny" && req.ctx.audit?.resourceType && req.ctx.audit?.action) {
      app.metrics.incAuthzDenied({ resourceType: req.ctx.audit.resourceType, action: req.ctx.audit.action });
    }
  });
};
