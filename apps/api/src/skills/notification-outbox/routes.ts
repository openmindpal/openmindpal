import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { getConnectorInstance, getConnectorType } from "../connector-manager/modules/connectorRepo";
import { getSmtpConnectorConfig } from "../connector-manager/modules/smtpRepo";
import { digestParams } from "../../lib/digest";
import { cancelOutbox, cancelOutboxByGovernance, enqueueOutbox, listOutbox, listOutboxByDeliveryStatus, retryOutbox } from "./modules/outboxRepo";
import { renderTemplateText } from "./modules/render";
import { createNotificationTemplate, getNotificationTemplate, setNotificationTemplateStatus } from "./modules/templateRepo";
import { createTemplateVersionDraft, getLatestReleasedVersion, getTemplateVersion, publishTemplateVersion } from "./modules/templateVersionRepo";
import { encryptJson } from "../../modules/secrets/crypto";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

function assertScope(template: { scopeType: string; scopeId: string }, subject: { tenantId: string; spaceId?: string | null }) {
  const s = resolveScope(subject);
  if (template.scopeType !== s.scopeType || template.scopeId !== s.scopeId) throw Errors.forbidden();
}

function pickLocale(contentI18n: any, locale: string) {
  const c = contentI18n && typeof contentI18n === "object" ? contentI18n : {};
  const exact = c[locale];
  if (exact) return { locale, content: exact };
  const fallback = c["zh-CN"];
  if (fallback) return { locale: "zh-CN", content: fallback };
  return null;
}

function masterKey() {
  return process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.post("/notifications/templates", async (req) => {
    setAuditContext(req, { resourceType: "notification_template", action: "create" });
    const decision = await requirePermission({ req, resourceType: "notification_template", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject);
    const body = z.object({ key: z.string().min(1).max(200), channel: z.enum(["email", "sms", "im", "inapp"]) }).parse(req.body);
    const t = await createNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, key: body.key, channel: body.channel });
    req.ctx.audit!.outputDigest = { templateId: t.templateId, key: t.key, channel: t.channel, scopeType: t.scopeType };
    return { template: t };
  });

  app.post("/notifications/templates/:templateId/disable", async (req) => {
    const params = z.object({ templateId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "notification_template", action: "disable" });
    const decision = await requirePermission({ req, resourceType: "notification_template", action: "disable" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const t = await getNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, templateId: params.templateId });
    if (!t) throw Errors.badRequest("模板不存在");
    assertScope(t, subject);
    const updated = await setNotificationTemplateStatus({ pool: app.db, tenantId: subject.tenantId, templateId: t.templateId, status: "disabled" });
    if (!updated) throw Errors.badRequest("模板不存在");
    req.ctx.audit!.outputDigest = { templateId: updated.templateId, status: updated.status };
    return { template: updated };
  });

  app.post("/notifications/templates/:templateId/versions", async (req) => {
    const params = z.object({ templateId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "notification_template", action: "version.create" });
    const decision = await requirePermission({ req, resourceType: "notification_template", action: "version.create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const t = await getNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, templateId: params.templateId });
    if (!t) throw Errors.badRequest("模板不存在");
    assertScope(t, subject);

    const body = z.object({ version: z.number().int().positive().max(10_000), contentI18n: z.record(z.string(), z.any()), paramsSchema: z.record(z.string(), z.any()).optional() }).parse(req.body);
    const v = await createTemplateVersionDraft({ pool: app.db, templateId: t.templateId, version: body.version, contentI18n: body.contentI18n, paramsSchema: body.paramsSchema ?? null });
    req.ctx.audit!.outputDigest = { templateId: t.templateId, version: v.version, status: v.status };
    return { version: v };
  });

  app.post("/notifications/templates/:templateId/versions/:version/publish", async (req) => {
    const params = z.object({ templateId: z.string().uuid(), version: z.coerce.number().int().positive() }).parse(req.params);
    setAuditContext(req, { resourceType: "notification_template", action: "publish" });
    const decision = await requirePermission({ req, resourceType: "notification_template", action: "publish" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const t = await getNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, templateId: params.templateId });
    if (!t) throw Errors.badRequest("模板不存在");
    assertScope(t, subject);

    const existing = await getTemplateVersion({ pool: app.db, templateId: t.templateId, version: params.version });
    if (!existing) throw Errors.badRequest("版本不存在");
    const published = await publishTemplateVersion({ pool: app.db, templateId: t.templateId, version: params.version });
    if (!published) throw Errors.badRequest("版本不存在");
    req.ctx.audit!.outputDigest = { templateId: t.templateId, version: published.version, status: published.status };
    return { version: published };
  });

  app.post("/notifications/templates/:templateId/preview", async (req) => {
    const params = z.object({ templateId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "notification_template", action: "preview" });
    const decision = await requirePermission({ req, resourceType: "notification_template", action: "preview" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const t = await getNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, templateId: params.templateId });
    if (!t) throw Errors.badRequest("模板不存在");
    assertScope(t, subject);
    if (t.status !== "active") throw Errors.badRequest("模板已禁用");

    const body = z.object({ version: z.number().int().positive().optional(), params: z.record(z.string(), z.any()).optional(), locale: z.string().min(2).max(20).optional() }).parse(req.body);
    const v = body.version ? await getTemplateVersion({ pool: app.db, templateId: t.templateId, version: body.version }) : await getLatestReleasedVersion({ pool: app.db, templateId: t.templateId });
    if (!v || v.status !== "released") throw Errors.badRequest("未发布版本不可预览");

    const locale = body.locale ?? req.ctx.locale;
    const picked = pickLocale(v.contentI18n, locale);
    if (!picked) throw Errors.badRequest("缺少可用语言内容");
    const title = renderTemplateText(String(picked.content?.title ?? ""), body.params ?? {});
    const text = renderTemplateText(String(picked.content?.body ?? ""), body.params ?? {});

    req.ctx.audit!.outputDigest = { templateId: t.templateId, version: v.version, locale: picked.locale, titleLen: title.length, bodyLen: text.length };
    return { templateId: t.templateId, version: v.version, locale: picked.locale, title, body: text };
  });

  app.post("/notifications/outbox", async (req) => {
    setAuditContext(req, { resourceType: "notification", action: "enqueue" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "enqueue" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        channel: z.enum(["email", "sms", "im", "inapp"]),
        recipientRef: z.string().min(1).max(500),
        templateId: z.string().uuid(),
        version: z.number().int().positive().optional(),
        connectorInstanceId: z.string().uuid().optional(),
        locale: z.string().min(2).max(20).optional(),
        params: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    const t = await getNotificationTemplate({ pool: app.db, tenantId: subject.tenantId, templateId: body.templateId });
    if (!t) throw Errors.badRequest("模板不存在");
    assertScope(t, subject);
    if (t.channel !== body.channel) throw Errors.badRequest("channel 与模板不匹配");
    if (t.status !== "active") throw Errors.badRequest("模板已禁用");

    const v = body.version ? await getTemplateVersion({ pool: app.db, templateId: t.templateId, version: body.version }) : await getLatestReleasedVersion({ pool: app.db, templateId: t.templateId });
    if (!v || v.status !== "released") throw Errors.badRequest("未发布版本不可使用");

    const locale = body.locale ?? req.ctx.locale;
    const picked = pickLocale(v.contentI18n, locale);
    if (!picked) throw Errors.badRequest("缺少可用语言内容");

    const title = renderTemplateText(String(picked.content?.title ?? ""), body.params ?? {});
    const text = renderTemplateText(String(picked.content?.body ?? ""), body.params ?? {});
    const contentCiphertext = encryptJson(masterKey(), { title, body: text });

    let connectorInstanceId: string | null = null;
    if (body.channel === "email") {
      if (!body.connectorInstanceId) throw Errors.badRequest("Email outbox 需要 connectorInstanceId");
      const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
      if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
      if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
      if (inst.typeName !== "mail.smtp") throw Errors.badRequest("ConnectorInstance 类型不支持 email 投递");
      const type = await getConnectorType(app.db, inst.typeName);
      if (!type) throw Errors.badRequest("连接器类型不存在");
      const cfg = await getSmtpConnectorConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id });
      if (!cfg) throw Errors.badRequest("SMTP 配置缺失");
      connectorInstanceId = inst.id;
    }

    const out = await enqueueOutbox({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      channel: body.channel,
      recipientRef: body.recipientRef,
      templateId: t.templateId,
      templateVersion: v.version,
      connectorInstanceId,
      locale: picked.locale,
      paramsDigest: digestParams(body.params ?? {}),
      contentCiphertext,
    });
    req.ctx.audit!.outputDigest = { outboxId: out.outboxId, templateId: out.templateId, version: out.templateVersion, locale: out.locale, status: out.deliveryStatus, titleLen: title.length, bodyLen: text.length };
    return { outbox: out };
  });

  app.get("/notifications/outbox", async (req) => {
    setAuditContext(req, { resourceType: "notification", action: "read" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const items = await listOutbox({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, limit: q.limit ?? 20, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: items.length, limit: q.limit ?? 20, offset: q.offset ?? 0 };
    return { outbox: items };
  });

  app.post("/notifications/outbox/:outboxId/cancel", async (req) => {
    const params = z.object({ outboxId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "notification", action: "cancel" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "cancel" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const out = await cancelOutbox({ pool: app.db, tenantId: subject.tenantId, outboxId: params.outboxId });
    if (!out) throw Errors.badRequest("Outbox 不存在或不可取消");
    if ((subject.spaceId ?? null) !== out.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    req.ctx.audit!.outputDigest = { outboxId: out.outboxId, status: out.status };
    return { outbox: out };
  });

  app.get("/governance/notifications/outbox", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "notification.outbox.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "notification.outbox.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z
      .object({
        status: z.enum(["queued", "failed", "deadletter", "sent", "canceled"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const items = await listOutboxByDeliveryStatus({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, deliveryStatus: q.status ?? "deadletter", limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { status: q.status ?? "deadletter", count: items.length };
    return { outbox: items };
  });

  app.post("/governance/notifications/outbox/:outboxId/retry", async (req) => {
    const params = z.object({ outboxId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "notification.outbox.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "notification.outbox.retry" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const out = await retryOutbox({ pool: app.db, tenantId: subject.tenantId, outboxId: params.outboxId });
    if (!out) throw Errors.badRequest("Outbox 不存在或不可重试");
    if ((subject.spaceId ?? null) !== out.spaceId) throw Errors.forbidden();
    req.ctx.audit!.outputDigest = { outboxId: out.outboxId, status: out.deliveryStatus };
    return { outbox: out };
  });

  app.post("/governance/notifications/outbox/:outboxId/cancel", async (req) => {
    const params = z.object({ outboxId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "notification.outbox.cancel" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "notification.outbox.cancel" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const out = await cancelOutboxByGovernance({ pool: app.db, tenantId: subject.tenantId, outboxId: params.outboxId });
    if (!out) throw Errors.badRequest("Outbox 不存在或不可取消");
    if ((subject.spaceId ?? null) !== out.spaceId) throw Errors.forbidden();
    req.ctx.audit!.outputDigest = { outboxId: out.outboxId, status: out.deliveryStatus };
    return { outbox: out };
  });
};
