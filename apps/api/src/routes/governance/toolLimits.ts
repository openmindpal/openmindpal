import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getToolLimit, listToolLimits, upsertToolLimit } from "../../modules/governance/limitsRepo";

export const governanceToolLimitsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/tool-limits", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "limits.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({ toolRef: z.string().min(3).optional(), limit: z.coerce.number().int().positive().max(500).optional() }).parse(req.query);
    if (q.toolRef) {
      const tl = await getToolLimit({ pool: app.db, tenantId: subject.tenantId, toolRef: q.toolRef });
      req.ctx.audit!.outputDigest = { toolRef: q.toolRef, found: Boolean(tl) };
      return { toolLimits: tl ? [tl] : [] };
    }
    const toolLimits = await listToolLimits({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 200 });
    req.ctx.audit!.outputDigest = { count: toolLimits.length };
    return { toolLimits };
  });

  app.put("/governance/tool-limits/:toolRef", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ defaultMaxConcurrency: z.number().int().positive().max(1000) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "limits.update", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "limits.update" });
    req.ctx.audit!.policyDecision = decision;

    const toolLimit = await upsertToolLimit({ pool: app.db, tenantId: subject.tenantId, toolRef: params.toolRef, defaultMaxConcurrency: body.defaultMaxConcurrency });
    req.ctx.audit!.outputDigest = { toolRef: toolLimit.toolRef, defaultMaxConcurrency: toolLimit.defaultMaxConcurrency };
    return { toolLimit };
  });
};

