import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import {
  createIdentityLink,
  listIdentityLinks,
  getIdentityLink,
  disableIdentityLink,
  deleteIdentityLink,
  switchIdentity,
} from "../../modules/auth/identityLinkRepo";

export const identityRoutes: FastifyPluginAsync = async (app) => {
  // ─── Identity Links ─────────────────────────────────────────────────
  app.get("/identity/links", async (req) => {
    setAuditContext(req, { resourceType: "identity", action: "list" });
    const decision = await requirePermission({ req, resourceType: "identity", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const links = await listIdentityLinks({ pool: app.db, tenantId: subject.tenantId, primarySubjectId: subject.subjectId, status: "active" });
    return { links };
  });

  app.post("/identity/links", async (req) => {
    setAuditContext(req, { resourceType: "identity", action: "create" });
    const decision = await requirePermission({ req, resourceType: "identity", action: "write" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const body = z.object({
      linkedSubjectId: z.string().min(1),
      identityLabel: z.string().optional(),
      providerType: z.string().optional(),
      providerRef: z.string().optional(),
    }).parse(req.body);
    const link = await createIdentityLink({ pool: app.db, tenantId: subject.tenantId, primarySubjectId: subject.subjectId, ...body });
    req.ctx.audit!.outputDigest = { linkId: link.linkId };
    return { link };
  });

  app.post("/identity/switch", async (req) => {
    setAuditContext(req, { resourceType: "identity", action: "switch" });
    const decision = await requirePermission({ req, resourceType: "identity", action: "write" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const body = z.object({ targetSubjectId: z.string().min(1) }).parse(req.body);
    const result = await switchIdentity({ pool: app.db, tenantId: subject.tenantId, currentSubjectId: subject.subjectId, targetSubjectId: body.targetSubjectId });
    req.ctx.audit!.outputDigest = result;
    return result;
  });

  app.delete("/identity/links/:linkId", async (req) => {
    const params = z.object({ linkId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "identity", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "identity", action: "write" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const ok = await deleteIdentityLink({ pool: app.db, tenantId: subject.tenantId, linkId: params.linkId });
    return { ok };
  });
};
