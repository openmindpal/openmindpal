import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { getConnectorInstance } from "../modules/connectors/connectorRepo";
import { getExchangeConnectorConfig } from "../modules/connectors/exchangeRepo";
import { getSubscription, listSubscriptions, createSubscription, setSubscriptionStatus } from "../modules/subscriptions/subscriptionRepo";
import { getLastRunBySubscription } from "../modules/subscriptions/subscriptionRunRepo";

function resolveSpaceScope(subject: { tenantId: string; spaceId?: string | null }) {
  return subject.spaceId ?? null;
}

function assertScopeAllowed(subject: { spaceId?: string | null }, subscription: { spaceId: string | null }) {
  const s = subject.spaceId ?? null;
  if (s !== subscription.spaceId) throw Errors.forbidden();
}

export const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.post("/subscriptions", async (req) => {
    setAuditContext(req, { resourceType: "subscription", action: "create" });
    const decision = await requirePermission({ req, resourceType: "subscription", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        provider: z.string().min(1).max(50),
        connectorInstanceId: z.string().uuid().optional(),
        pollIntervalSec: z.number().int().min(10).max(3600).optional(),
        watermark: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    if (body.provider === "imap") {
      if (!body.connectorInstanceId) throw Errors.badRequest("IMAP subscription 需要 connectorInstanceId");
      const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
      if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
      if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
      const spaceId = resolveSpaceScope(subject);
      if ((spaceId ?? null) !== (inst.scopeType === "space" ? inst.scopeId : null)) throw Errors.forbidden();
      if (inst.typeName !== "mail.imap") throw Errors.badRequest("ConnectorInstance 类型不支持 IMAP subscription");
    }

    if (body.provider === "exchange") {
      if (!body.connectorInstanceId) throw Errors.badRequest("Exchange subscription 需要 connectorInstanceId");
      const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
      if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
      if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
      const spaceId = resolveSpaceScope(subject);
      if ((spaceId ?? null) !== (inst.scopeType === "space" ? inst.scopeId : null)) throw Errors.forbidden();
      if (inst.typeName !== "mail.exchange") throw Errors.badRequest("ConnectorInstance 类型不支持 Exchange subscription");
      const cfg = await getExchangeConnectorConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id });
      if (!cfg) throw Errors.badRequest("Exchange 配置缺失");
    }

    const sub = await createSubscription({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: resolveSpaceScope(subject),
      provider: body.provider,
      connectorInstanceId: body.connectorInstanceId ?? null,
      pollIntervalSec: body.pollIntervalSec ?? 60,
      watermark: body.watermark ?? null,
    });

    req.ctx.audit!.outputDigest = { subscriptionId: sub.subscriptionId, provider: sub.provider, status: sub.status, pollIntervalSec: sub.pollIntervalSec };
    return { subscription: sub };
  });

  app.get("/subscriptions", async (req) => {
    setAuditContext(req, { resourceType: "subscription", action: "read" });
    const decision = await requirePermission({ req, resourceType: "subscription", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const spaceId = resolveSpaceScope(subject);
    const subs = await listSubscriptions({ pool: app.db, tenantId: subject.tenantId, spaceId, limit: q.limit ?? 20, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: subs.length, limit: q.limit ?? 20, offset: q.offset ?? 0 };
    return { subscriptions: subs };
  });

  app.get("/subscriptions/:subscriptionId", async (req, reply) => {
    const params = z.object({ subscriptionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "subscription", action: "read" });
    const decision = await requirePermission({ req, resourceType: "subscription", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const sub = await getSubscription({ pool: app.db, tenantId: subject.tenantId, subscriptionId: params.subscriptionId });
    if (!sub) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Subscription 不存在", "en-US": "Subscription not found" }, traceId: req.ctx.traceId });
    assertScopeAllowed(subject, sub);
    const lastRun = await getLastRunBySubscription({ pool: app.db, tenantId: subject.tenantId, subscriptionId: sub.subscriptionId });
    req.ctx.audit!.outputDigest = { subscriptionId: sub.subscriptionId, provider: sub.provider, hasLastRun: Boolean(lastRun) };
    return { subscription: sub, lastRun };
  });

  app.post("/subscriptions/:subscriptionId/disable", async (req) => {
    const params = z.object({ subscriptionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "subscription", action: "disable" });
    const decision = await requirePermission({ req, resourceType: "subscription", action: "disable" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const existing = await getSubscription({ pool: app.db, tenantId: subject.tenantId, subscriptionId: params.subscriptionId });
    if (!existing) throw Errors.badRequest("Subscription 不存在");
    assertScopeAllowed(subject, existing);
    const updated = await setSubscriptionStatus({ pool: app.db, tenantId: subject.tenantId, subscriptionId: params.subscriptionId, status: "disabled" });
    if (!updated) throw Errors.badRequest("Subscription 不存在");
    req.ctx.audit!.outputDigest = { subscriptionId: updated.subscriptionId, status: updated.status };
    return { subscription: updated };
  });

  app.post("/subscriptions/:subscriptionId/enable", async (req) => {
    const params = z.object({ subscriptionId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "subscription", action: "enable" });
    const decision = await requirePermission({ req, resourceType: "subscription", action: "enable" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const existing = await getSubscription({ pool: app.db, tenantId: subject.tenantId, subscriptionId: params.subscriptionId });
    if (!existing) throw Errors.badRequest("Subscription 不存在");
    assertScopeAllowed(subject, existing);
    const updated = await setSubscriptionStatus({ pool: app.db, tenantId: subject.tenantId, subscriptionId: params.subscriptionId, status: "enabled" });
    if (!updated) throw Errors.badRequest("Subscription 不存在");
    req.ctx.audit!.outputDigest = { subscriptionId: updated.subscriptionId, status: updated.status };
    return { subscription: updated };
  });
};
