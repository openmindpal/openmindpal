import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { getPolicySnapshot } from "../modules/auth/policySnapshotRepo";

export const policySnapshotRoutes: FastifyPluginAsync = async (app) => {
  app.get("/policy-snapshots/:snapshotId", async (req) => {
    const params = z.object({ snapshotId: z.string().min(10) }).parse(req.params);
    setAuditContext(req, { resourceType: "policy_snapshot", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "policy_snapshot", action: "read" });

    const subject = req.ctx.subject!;
    const snap = await getPolicySnapshot({ pool: app.db, tenantId: subject.tenantId, snapshotId: params.snapshotId });
    if (!snap) throw Errors.badRequest("Policy snapshot 不存在");
    req.ctx.audit!.outputDigest = { snapshotId: snap.snapshotId, decision: snap.decision, resourceType: snap.resourceType, action: snap.action };
    return { snapshot: snap };
  });
};

