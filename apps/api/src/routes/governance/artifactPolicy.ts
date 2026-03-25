import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getArtifactPolicy, upsertArtifactPolicy } from "../../modules/governance/artifactPolicyRepo";

export const governanceArtifactPolicyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/artifact-policy", async (req, reply) => {
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "artifact.policy.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "artifact.policy.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const pol = await getArtifactPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId });
    if (!pol) {
      req.ctx.audit!.outputDigest = { scopeType, scopeId, found: false };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "策略不存在", "en-US": "Policy not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = {
      scopeType,
      scopeId,
      watermarkHeadersEnabled: pol.watermarkHeadersEnabled,
      downloadTokenExpiresInSec: pol.downloadTokenExpiresInSec,
      downloadTokenMaxUses: pol.downloadTokenMaxUses,
    };
    return pol;
  });

  app.put("/governance/artifact-policy", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        downloadTokenExpiresInSec: z.number().int().positive().max(3600).optional(),
        downloadTokenMaxUses: z.number().int().positive().max(10).optional(),
        watermarkHeadersEnabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "artifact.policy.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "artifact.policy.write" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const expiresInSec = body.downloadTokenExpiresInSec ?? 300;
    const maxUses = body.downloadTokenMaxUses ?? 1;
    const watermarkHeadersEnabled = body.watermarkHeadersEnabled ?? true;
    req.ctx.audit!.inputDigest = { scopeType, scopeId, downloadTokenExpiresInSec: expiresInSec, downloadTokenMaxUses: maxUses, watermarkHeadersEnabled };
    await upsertArtifactPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      downloadTokenExpiresInSec: expiresInSec,
      downloadTokenMaxUses: maxUses,
      watermarkHeadersEnabled,
    });
    req.ctx.audit!.outputDigest = { ok: true };
    return { ok: true };
  });
};

