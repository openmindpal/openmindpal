import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { disablePartitionKey, initPartitionKey, rotatePartitionKey } from "../modules/keyring/keyringRepo";

export const keyringRoutes: FastifyPluginAsync = async (app) => {
  app.post("/keyring/keys/init", async (req) => {
    const body = z.object({ scopeType: z.enum(["tenant", "space"]), spaceId: z.string().min(1).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "keyring", action: "init" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "keyring", action: "init" });
    const subject = req.ctx.subject!;
    const scopeId = body.scopeType === "tenant" ? subject.tenantId : body.spaceId ?? subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 spaceId");
    if (body.scopeType === "space" && subject.spaceId && subject.spaceId !== scopeId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const k = await initPartitionKey({ pool: app.db, tenantId: subject.tenantId, scopeType: body.scopeType, scopeId, masterKey: app.cfg.secrets.masterKey });
    const out = { scopeType: k.scopeType, scopeId: k.scopeId, keyVersion: k.keyVersion, status: k.status };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/keyring/keys/rotate", async (req) => {
    const body = z.object({ scopeType: z.enum(["tenant", "space"]), spaceId: z.string().min(1).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "keyring", action: "rotate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "keyring", action: "rotate" });
    const subject = req.ctx.subject!;
    const scopeId = body.scopeType === "tenant" ? subject.tenantId : body.spaceId ?? subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 spaceId");
    if (body.scopeType === "space" && subject.spaceId && subject.spaceId !== scopeId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const k = await rotatePartitionKey({ pool: app.db, tenantId: subject.tenantId, scopeType: body.scopeType, scopeId, masterKey: app.cfg.secrets.masterKey });
    const out = { scopeType: k.scopeType, scopeId: k.scopeId, keyVersion: k.keyVersion, status: k.status };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/keyring/keys/disable", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        spaceId: z.string().min(1).optional(),
        keyVersion: z.number().int().min(1),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "keyring", action: "disable" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "keyring", action: "disable" });
    const subject = req.ctx.subject!;
    const scopeId = body.scopeType === "tenant" ? subject.tenantId : body.spaceId ?? subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 spaceId");
    if (body.scopeType === "space" && subject.spaceId && subject.spaceId !== scopeId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const k = await disablePartitionKey({ pool: app.db, tenantId: subject.tenantId, scopeType: body.scopeType, scopeId, keyVersion: body.keyVersion });
    if (!k) throw Errors.badRequest("Key 不存在");
    const out = { scopeType: k.scopeType, scopeId: k.scopeId, keyVersion: k.keyVersion, status: k.status };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/keyring/keys/reencrypt", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        spaceId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "keyring", action: "reencrypt.requested" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "keyring", action: "reencrypt" });
    const subject = req.ctx.subject!;
    const scopeId = body.scopeType === "tenant" ? subject.tenantId : body.spaceId ?? subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 spaceId");
    if (body.scopeType === "space" && subject.spaceId && subject.spaceId !== scopeId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const job = await app.queue.add(
      "step",
      { kind: "keyring.reencrypt", tenantId: subject.tenantId, scopeType: body.scopeType, scopeId, limit: body.limit ?? 500 },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
    );
    const out = { jobId: String(job.id), scopeType: body.scopeType, scopeId, limit: body.limit ?? 500 };
    req.ctx.audit!.outputDigest = out;
    return out;
  });
};
