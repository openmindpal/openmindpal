import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { orchestrateTurn } from "../modules/orchestrator/orchestrator";
import { sha256Hex, stableStringify } from "../modules/channels/ingressDigest";
import { getChannelProviderAdapter } from "../modules/channels/providerAdapters";
import { testFeishuConfig } from "../modules/channels/providerFeishu";
import { handleBridgeEvents } from "../modules/channels/providerBridge";
import { resolveChannelSecretPayload } from "../modules/channels/channelSecret";
import {
  finalizeIngressEvent,
  getChannelAccount,
  getChannelChatBinding,
  getIngressEvent,
  getIngressEventById,
  getWebhookConfig,
  listWebhookConfigs,
  getLatestOutboxByRequestId,
  insertIngressEvent,
  insertOutboxMessage,
  listIngressEventsByStatus,
  listUndeliveredOutboxMessages,
  markIngressQueued,
  markOutboxAcked,
  markOutboxDelivered,
  upsertChannelAccount,
  upsertChannelChatBinding,
  upsertWebhookConfig,
} from "../modules/channels/channelRepo";

function hmacHex(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

export const channelRoutes: FastifyPluginAsync = async (app) => {
  app.post("/channels/feishu/events", async (req, reply) => {
    const adapter = getChannelProviderAdapter("feishu");
    return adapter.handle({ app, req, reply });
  });

  app.register(async (sub) => {
    sub.addContentTypeParser("application/json", { parseAs: "string" }, async (_req: any, body: any) => body);

    sub.post("/channels/slack/events", async (req, reply) => {
      const adapter = getChannelProviderAdapter("slack");
      return adapter.handle({ app, req, reply });
    });

    sub.post("/channels/discord/interactions", async (req, reply) => {
      const adapter = getChannelProviderAdapter("discord");
      return adapter.handle({ app, req, reply });
    });
  });

  app.post("/channels/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply });
  });

  app.post("/channels/qq/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "qq.onebot" });
  });

  app.post("/channels/imessage/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "imessage.bridge" });
  });

  app.post("/channels/dingtalk/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "dingtalk" });
  });

  app.post("/channels/wecom/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "wecom" });
  });

  app.post("/channels/slack/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "slack" });
  });

  app.post("/channels/discord/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "discord" });
  });

  app.post("/channels/webhook/ingress", async (req, reply) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        timestamp: z.union([z.number().int().positive(), z.string().min(1)]),
        nonce: z.string().min(1),
        channelUserId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        text: z.string().max(20000).optional(),
        payload: z.any().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "channel", action: "webhook.ingress" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const timestampSec =
      typeof body.timestamp === "number"
        ? Math.floor(body.timestamp / 1000)
        : Math.floor(Date.parse(body.timestamp) / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const bodyForDigest = {
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      timestamp: timestampSec,
      nonce: body.nonce,
      channelUserId: body.channelUserId ?? null,
      channelChatId: body.channelChatId ?? null,
      text: body.text ?? null,
      payload: body.payload ?? null,
    };
    const bodyDigest = sha256Hex(stableStringify(bodyForDigest));

    const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    if (Math.abs(nowSec - timestampSec) > cfg.toleranceSec) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }
    if (!cfg.secretEnvKey) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    const secret = process.env[cfg.secretEnvKey];
    if (!secret) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    const signature = (req.headers["x-signature"] as string | undefined) ?? "";
    const signingInput = `${timestampSec}.${body.nonce}.${body.eventId}.${bodyDigest}`;
    const expected = hmacHex(secret, signingInput);
    if (!signature || signature !== expected) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelSignatureInvalid();
    }

    const inserted = await insertIngressEvent({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      nonce: body.nonce,
      bodyDigest,
      bodyJson: bodyForDigest,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "received",
    });

    if (!inserted) {
      const prior = await getIngressEvent({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId });
      if (prior?.responseStatusCode && prior.responseJson) {
        req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: body.eventId };
        reply.status(prior.responseStatusCode);
        return prior.responseJson;
      }
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    let subjectId: string | null = null;
    let spaceId: string | null = null;
    if (body.channelUserId) {
      const acc = await getChannelAccount({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId });
      if (acc && acc.status === "active") {
        subjectId = acc.subjectId;
        spaceId = acc.spaceId ?? null;
      }
    }
    if (!subjectId && body.channelChatId) {
      const binding = await getChannelChatBinding({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId });
      if (binding && binding.status === "active") {
        subjectId = binding.defaultSubjectId ?? null;
        spaceId = binding.spaceId;
      }
    }
    if (!subjectId || !spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.channelMappingMissing();
      await finalizeIngressEvent({
        pool: app.db,
        id: inserted.id,
        status: "denied",
        responseStatusCode: 403,
        responseJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      throw Errors.channelMappingMissing();
    }

    req.ctx.subject = { subjectId, tenantId, spaceId };
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    if (cfg.deliveryMode === "async") {
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "queued", responseStatusCode: 202, responseJson: resp });
      req.ctx.audit!.outputDigest = { status: "queued", provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId };
      reply.status(202);
      return resp;
    }

    try {
      const out = await orchestrateTurn({ pool: app.db, tenantId, spaceId, message: body.text ?? "" });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "succeeded", result: out };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
      req.ctx.audit!.outputDigest = { status: "succeeded", provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId };
      return resp;
    } catch (e: any) {
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "failed" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
      throw e;
    }
  });

  app.post("/governance/channels/webhook/configs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        spaceId: z.string().min(1).optional(),
        secretEnvKey: z.string().min(1).optional(),
        secretId: z.string().uuid().optional(),
        providerConfig: z.record(z.string(), z.any()).optional(),
        toleranceSec: z.number().int().positive().max(3600).optional(),
        deliveryMode: z.enum(["sync", "async"]).optional(),
        maxAttempts: z.number().int().min(1).max(50).optional(),
        backoffMsBase: z.number().int().min(0).max(60_000).optional(),
      })
      .parse(req.body);
    if (!body.secretEnvKey && !body.secretId) throw Errors.badRequest("secretEnvKey 或 secretId 必填其一");
    const cfg = await upsertWebhookConfig({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      spaceId: body.spaceId ?? null,
      secretEnvKey: body.secretEnvKey ?? null,
      secretId: body.secretId ?? null,
      providerConfig: body.providerConfig ?? null,
      toleranceSec: body.toleranceSec,
      deliveryMode: body.deliveryMode,
      maxAttempts: body.maxAttempts,
      backoffMsBase: body.backoffMsBase,
    });
    req.ctx.audit!.outputDigest = { provider: cfg.provider, workspaceId: cfg.workspaceId };
    return { config: cfg };
  });

  app.get("/governance/channels/webhook/configs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const configs = await listWebhookConfigs({ pool: app.db, tenantId: subject.tenantId, provider: q.provider, workspaceId: q.workspaceId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: configs.length };
    return { configs };
  });

  app.post("/governance/channels/providers/feishu/test", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ workspaceId: z.string().min(1) }).parse(req.body);
    const cfg = await getWebhookConfig({ pool: app.db, tenantId: subject.tenantId, provider: "feishu", workspaceId: body.workspaceId });
    if (!cfg) throw Errors.channelConfigMissing();
    const result = await testFeishuConfig({ app, tenantId: subject.tenantId, cfg });
    req.ctx.audit!.outputDigest = { provider: "feishu", workspaceId: body.workspaceId, ok: true };
    return { result };
  });

  app.post("/governance/channels/providers/test", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ provider: z.string().min(1), workspaceId: z.string().min(1) }).parse(req.body);
    const cfg = await getWebhookConfig({ pool: app.db, tenantId: subject.tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) throw Errors.channelConfigMissing();

    if (body.provider === "feishu") {
      const result = await testFeishuConfig({ app, tenantId: subject.tenantId, cfg });
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result };
    }

    const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app, tenantId: subject.tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
    const envSecret = cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "";
    const webhookSecret = envSecret || (typeof (secretPayload as any).webhookSecret === "string" ? String((secretPayload as any).webhookSecret) : "");
    const slackSigningSecret = typeof (secretPayload as any).slackSigningSecret === "string" ? String((secretPayload as any).slackSigningSecret) : "";
    const discordPublicKey = typeof (secretPayload as any).discordPublicKey === "string" ? String((secretPayload as any).discordPublicKey) : "";

    const bridgeBaseUrl = typeof (secretPayload as any).bridgeBaseUrl === "string" ? String((secretPayload as any).bridgeBaseUrl) : "";
    const webhookUrl = typeof (secretPayload as any).webhookUrl === "string" ? String((secretPayload as any).webhookUrl) : "";
    const slackBotToken = typeof (secretPayload as any).slackBotToken === "string" ? String((secretPayload as any).slackBotToken) : "";

    if (body.provider === "qq.onebot" || body.provider === "imessage.bridge") {
      if (!webhookSecret || !bridgeBaseUrl) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "bridge", hasBridgeBaseUrl: true, hasWebhookSecret: true } };
    }
    if (body.provider === "slack") {
      if (!slackBotToken || (!slackSigningSecret && !webhookSecret)) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "slack_api", hasSlackSigningSecret: !!slackSigningSecret, hasWebhookSecret: !!webhookSecret, hasSlackBotToken: true } };
    }
    if (body.provider === "dingtalk" || body.provider === "wecom") {
      if (!webhookSecret || !webhookUrl) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "webhook", hasWebhookSecret: true, hasWebhookUrl: true } };
    }
    if (body.provider === "discord") {
      if (!discordPublicKey && (!webhookSecret || !webhookUrl)) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "discord", hasDiscordPublicKey: !!discordPublicKey, hasWebhookSecret: !!webhookSecret, hasWebhookUrl: !!webhookUrl } };
    }
    req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
    return { result: { ok: true, mode: "unknown", hasWebhookSecret: !!webhookSecret } };
  });

  app.get("/governance/channels/ingress-events", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.ingress.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.ingress.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        status: z.enum(["failed", "deadletter", "queued"]).optional(),
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const status = q.status ?? "deadletter";
    const events = await listIngressEventsByStatus({ pool: app.db, tenantId: subject.tenantId, status, provider: q.provider, workspaceId: q.workspaceId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { status, count: events.length };
    return { events };
  });

  app.post("/governance/channels/ingress-events/:id/retry", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "channel.ingress.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.ingress.retry" });
    req.ctx.audit!.policyDecision = decision;

    const existing = await getIngressEventById({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!existing) throw Errors.badRequest("IngressEvent 不存在");
    const updated = await markIngressQueued({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!updated) throw Errors.badRequest("IngressEvent 不存在");
    req.ctx.audit!.outputDigest = { id: updated.id, status: updated.status };
    return { event: updated };
  });

  app.post("/governance/channels/accounts", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.mapping.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.mapping.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelUserId: z.string().min(1),
        subjectId: z.string().min(1),
        spaceId: z.string().min(1),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body);
    const acc = await upsertChannelAccount({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelUserId: body.channelUserId,
      subjectId: body.subjectId,
      spaceId: body.spaceId,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { provider: acc.provider, workspaceId: acc.workspaceId, channelUserId: acc.channelUserId, subjectId: acc.subjectId };
    return { account: acc };
  });

  app.post("/governance/channels/chats", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.mapping.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.mapping.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        spaceId: z.string().min(1),
        defaultSubjectId: z.string().min(1).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body);
    const binding = await upsertChannelChatBinding({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      spaceId: body.spaceId,
      defaultSubjectId: body.defaultSubjectId ?? null,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { provider: binding.provider, workspaceId: binding.workspaceId, channelChatId: binding.channelChatId, spaceId: binding.spaceId };
    return { chat: binding };
  });

  app.post("/channels/im/mock/ingress", async (req, reply) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        timestamp: z.union([z.number().int().positive(), z.string().min(1)]),
        channelUserId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        type: z.enum(["message", "command", "callback"]),
        text: z.string().max(20000).optional(),
        command: z.object({ name: z.string().min(1), args: z.record(z.string(), z.any()).optional() }).optional(),
        callback: z.object({ actionId: z.string().min(1), value: z.any().optional(), messageRef: z.string().min(1).optional() }).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "channel", action: "im.ingress" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const timestampSec =
      typeof body.timestamp === "number"
        ? Math.floor(body.timestamp / 1000)
        : Math.floor(Date.parse(body.timestamp) / 1000);
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const payloadForDigest = {
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      timestamp: timestampSec,
      channelUserId: body.channelUserId ?? null,
      channelChatId: body.channelChatId ?? null,
      type: body.type,
      text: body.text ?? null,
      command: body.command ?? null,
      callback: body.callback ?? null,
    };
    const bodyDigest = sha256Hex(stableStringify(payloadForDigest));

    const inserted = await insertIngressEvent({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      nonce: body.eventId,
      bodyDigest,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "received",
    });

    if (!inserted) {
      const prior = await getIngressEvent({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId });
      if (prior?.responseStatusCode && prior.responseJson) {
        req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: body.eventId };
        reply.status(prior.responseStatusCode);
        return prior.responseJson;
      }
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    let subjectId: string | null = null;
    let spaceId: string | null = null;
    let channelChatId = body.channelChatId ?? null;

    if (body.channelUserId) {
      const acc = await getChannelAccount({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId });
      if (acc && acc.status === "active") {
        subjectId = acc.subjectId;
        spaceId = acc.spaceId ?? null;
      }
    }
    if (!subjectId && body.channelChatId) {
      const binding = await getChannelChatBinding({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId });
      if (binding && binding.status === "active") {
        subjectId = binding.defaultSubjectId ?? null;
        spaceId = binding.spaceId;
        channelChatId = binding.channelChatId;
      }
    }

    if (!subjectId || !spaceId || !channelChatId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.channelMappingMissing();
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "denied", errorCode: err.errorCode };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId: channelChatId ?? "unknown",
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "denied",
        messageJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      throw err;
    }

    req.ctx.subject = { subjectId, tenantId, spaceId };
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const received = await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "processing",
      messageJson: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" },
    });

    const inputText =
      body.type === "message"
        ? body.text ?? ""
        : body.type === "command"
          ? `/${body.command?.name ?? "command"} ${stableStringify(body.command?.args ?? {})}`
          : `callback:${body.callback?.actionId ?? ""} ${stableStringify(body.callback?.value ?? null)}`;

    try {
      const out = await orchestrateTurn({ pool: app.db, tenantId, spaceId, message: inputText });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "succeeded", result: out };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "succeeded",
        messageJson: resp,
      });
      req.ctx.audit!.outputDigest = { status: "succeeded", outboxId: received.id, eventId: body.eventId };
      return resp;
    } catch (e: any) {
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "failed" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "failed",
        messageJson: resp,
      });
      throw e;
    }
  });

  app.post("/channels/im/mock/outbox/poll", async (req) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.outbox.poll" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const msgs = await listUndeliveredOutboxMessages({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      limit: body.limit ?? 20,
    });
    await markOutboxDelivered({ pool: app.db, tenantId, ids: msgs.map((m) => m.id) });
    req.ctx.audit!.outputDigest = { count: msgs.length };
    return { messages: msgs };
  });

  app.post("/channels/im/mock/outbox/ack", async (req) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.outbox.ack" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const rows = await markOutboxAcked({ pool: app.db, tenantId, ids: body.ids });
    req.ctx.audit!.outputDigest = { count: rows.length };
    return { acked: rows.map((r) => r.id) };
  });

  app.post("/channels/im/mock/cancel", async (req) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        requestId: z.string().uuid(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.cancel" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const prior = await getLatestOutboxByRequestId({ pool: app.db, tenantId, requestId: body.requestId });
    if (!prior) throw Errors.badRequest("correlation 不存在");
    const resp = { correlation: { requestId: body.requestId }, status: "canceled" as const };
    await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      requestId: body.requestId,
      traceId: prior.traceId,
      status: "canceled",
      messageJson: resp,
    });
    req.ctx.audit!.outputDigest = { requestId: body.requestId };
    return resp;
  });
};
