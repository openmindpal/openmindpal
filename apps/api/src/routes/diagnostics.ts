import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";

async function countKeysByPattern(params: { redis: any; pattern: string; maxScans: number }) {
  let cursor = "0";
  let scanned = 0;
  let count = 0;
  do {
    const [next, keys] = (await params.redis.scan(cursor, "MATCH", params.pattern, "COUNT", "200")) as unknown as [string, string[]];
    cursor = next;
    scanned += 1;
    count += keys.length;
  } while (cursor !== "0" && scanned < params.maxScans);
  return { count, truncated: cursor !== "0" };
}

export const diagnosticsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/diagnostics", async (req) => {
    setAuditContext(req, { resourceType: "diagnostics", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "diagnostics.read" });

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    const scopeType = q.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;

    const counts =
      app.queue && typeof (app.queue as any).getJobCounts === "function"
        ? await (app.queue as any).getJobCounts("waiting", "active", "delayed", "failed", "completed")
        : { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };

    const cbPattern = `cb:model_chat:open:${subject.tenantId}:*`;
    const cb = await countKeysByPattern({ redis: app.redis, pattern: cbPattern, maxScans: 20 });

    req.ctx.audit!.outputDigest = { scopeType, queue: counts, circuitOpenCount: cb.count, circuitOpenTruncated: cb.truncated };
    return {
      scopeType,
      scopeId: scopeId ?? null,
      queue: counts,
      modelCircuit: { openCount: cb.count, truncated: cb.truncated },
      traceId: req.ctx.traceId,
    };
  });
};
