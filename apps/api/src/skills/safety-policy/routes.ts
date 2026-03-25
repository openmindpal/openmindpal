import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { requireSubject } from "../../modules/auth/guard";
import {
  createSafetyPolicyDraft,
  getEffectiveSafetyPolicyVersion,
  getSafetyPolicy,
  getSafetyPolicyVersion,
  listSafetyPolicies,
  listSafetyPolicyVersions,
  updateSafetyPolicyDraft,
} from "./modules/safetyPolicyRepo";

function diffSummary(a: unknown, b: unknown) {
  const aStr = JSON.stringify(a ?? null);
  const bStr = JSON.stringify(b ?? null);
  if (aStr === bStr) return { changed: false, aSize: aStr.length, bSize: bStr.length };
  return { changed: true, aSize: aStr.length, bSize: bStr.length };
}

export const safetyPolicyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/safety-policies", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "read" });
    const subject = requireSubject(req);
    const q = req.query as any;
    const policyType = z.enum(["content", "injection", "risk"]).optional().parse(q?.policyType);
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const items = await listSafetyPolicies({ pool: app.db, tenantId: subject.tenantId, policyType: policyType ?? null, limit });
    req.ctx.audit!.outputDigest = { count: items.length, policyType: policyType ?? null };
    return { items };
  });

  app.post("/governance/safety-policies", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "write" });
    const subject = requireSubject(req);
    const body = z
      .object({
        policyType: z.enum(["content", "injection", "risk"]),
        name: z.string().min(1).max(120),
        policyJson: z.unknown(),
      })
      .parse(req.body);
    const ver = await createSafetyPolicyDraft({ pool: app.db, tenantId: subject.tenantId, policyType: body.policyType, name: body.name, policyJson: body.policyJson });
    req.ctx.audit!.outputDigest = { policyId: ver.policyId, version: ver.version, status: ver.status, policyType: body.policyType };
    return { version: ver };
  });

  app.put("/governance/safety-policies/:policyId/versions/:version", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "write" });
    const subject = requireSubject(req);
    const params = z.object({ policyId: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ policyJson: z.unknown() }).parse(req.body);
    const updated = await updateSafetyPolicyDraft({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId, version: params.version, policyJson: body.policyJson });
    if (!updated) throw Errors.badRequest("仅允许更新 draft 版本");
    req.ctx.audit!.outputDigest = { policyId: params.policyId, version: params.version, status: updated.status };
    return { version: updated };
  });

  app.get("/governance/safety-policies/:policyId/versions", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const policy = await getSafetyPolicy({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId });
    if (!policy) throw Errors.badRequest("Policy 不存在");
    const versions = await listSafetyPolicyVersions({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId, limit });
    req.ctx.audit!.outputDigest = { policyId: params.policyId, count: versions.length };
    return { policy, versions };
  });

  app.get("/governance/safety-policies/:policyId/versions/:version", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ policyId: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(req.params);
    const ver = await getSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId, version: params.version });
    if (!ver) throw Errors.badRequest("Policy 版本不存在");
    req.ctx.audit!.outputDigest = { policyId: params.policyId, version: params.version, status: ver.status };
    return { version: ver };
  });

  app.get("/governance/safety-policies/:policyId/diff", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    const q = req.query as any;
    const from = z.coerce.number().int().positive().parse(q?.from);
    const to = z.coerce.number().int().positive().parse(q?.to);
    const a = await getSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId, version: from });
    const b = await getSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, policyId: params.policyId, version: to });
    if (!a || !b) throw Errors.badRequest("Policy 版本不存在");
    const summary = diffSummary(a.policyJson, b.policyJson);
    req.ctx.audit!.outputDigest = { policyId: params.policyId, from, to, changed: summary.changed };
    return { from: { version: a.version, digest: a.policyDigest, status: a.status }, to: { version: b.version, digest: b.policyDigest, status: b.status }, summary };
  });

  app.get("/governance/safety-policies/active/effective", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "read" });
    const subject = requireSubject(req);
    const q = req.query as any;
    const policyType = z.enum(["content", "injection", "risk"]).parse(q?.policyType);
    const eff = await getEffectiveSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, policyType });
    req.ctx.audit!.outputDigest = { policyType, hasActive: Boolean(eff), policyDigest: eff?.policyDigest ?? null };
    return { effective: eff };
  });
};
