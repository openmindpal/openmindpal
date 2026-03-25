import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { setAuditContext } from "../../../modules/audit/context";
import { requirePermission } from "../../../modules/auth/guard";
import { orchestrateChatTurn } from "../../orchestrator/modules/orchestrator";
import { resolveChannelSecretPayload } from "./channelSecret";
import {
  finalizeIngressEvent,
  getChannelAccount,
  getChannelChatBinding,
  getIngressEvent,
  getWebhookConfig,
  insertIngressEvent,
  insertOutboxMessage,
  markOutboxAcked,
  markOutboxDelivered,
} from "./channelRepo";
import { computeBridgeBodyDigest } from "./bridgeContract";
import { channelConversationId } from "./conversationId";
import { verifyDiscordSignature } from "./discord";

function pickSecret(payload: Record<string, unknown>, key: string) {
  const v = payload[key];
  return typeof v === "string" ? String(v) : "";
}

function pickI18nText(locale: string, v: unknown) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const o: any = v as any;
  const direct = typeof o[locale] === "string" ? o[locale] : "";
  if (direct) return direct;
  const zh = typeof o["zh-CN"] === "string" ? o["zh-CN"] : "";
  if (zh) return zh;
  const vals = Object.values(o).filter((x) => typeof x === "string") as string[];
  return vals[0] ?? "";
}

function toReplyText(locale: string, out: any) {
  if (out && typeof out === "object") return pickI18nText(locale, (out as any).replyText);
  return "";
}

export async function handleDiscordInteractions(ctx: { app: any; req: any; reply: any }) {
  const rawBody = typeof ctx.req.body === "string" ? ctx.req.body : JSON.stringify(ctx.req.body ?? {});
  const body = z.any().parse(JSON.parse(rawBody));

  setAuditContext(ctx.req, { resourceType: "channel", action: "discord.ingress" });
  const tenantId = (ctx.req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";

  const appId = String(body?.application_id ?? "").trim();
  if (!appId) throw Errors.badRequest("workspaceId 缺失");
  const cfg = await getWebhookConfig({ pool: ctx.app.db, tenantId, provider: "discord", workspaceId: appId });
  if (!cfg) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }

  const ts = String((ctx.req.headers["x-signature-timestamp"] as string | undefined) ?? "");
  const sig = String((ctx.req.headers["x-signature-ed25519"] as string | undefined) ?? "");
  if (!ts || !sig) throw Errors.badRequest("signature headers 缺失");

  const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app: ctx.app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
  const publicKeyHex = pickSecret(secretPayload, "discordPublicKey");
  if (!publicKeyHex) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }
  verifyDiscordSignature({ publicKeyHex, signatureHex: sig, timestamp: ts, rawBody });

  const typ = Number(body?.type ?? 0);
  if (typ === 1) {
    ctx.req.ctx.audit!.outputDigest = { provider: "discord", workspaceId: appId, type: "ping" };
    return { type: 1 };
  }

  const eventId = String(body?.id ?? "").trim();
  if (!eventId) throw Errors.badRequest("eventId 缺失");

  const channelChatId = String(body?.channel_id ?? "").trim();
  const channelUserId = String(body?.member?.user?.id ?? body?.user?.id ?? "").trim();
  const cmdName = String(body?.data?.name ?? "").trim();
  const msgText = cmdName ? `/${cmdName}` : "interaction";

  const bodyDigest = computeBridgeBodyDigest({
    provider: "discord",
    workspaceId: appId,
    eventId,
    timestamp: ts,
    channelChatId: channelChatId || null,
    channelUserId: channelUserId || null,
    text: msgText || null,
    payload: body ?? null,
  });

  const inserted = await insertIngressEvent({
    pool: ctx.app.db,
    tenantId,
    provider: "discord",
    workspaceId: appId,
    eventId,
    nonce: ts,
    bodyDigest,
    bodyJson: body,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "received",
  });

  if (!inserted) {
    const prior = await getIngressEvent({ pool: ctx.app.db, tenantId, provider: "discord", workspaceId: appId, eventId });
    if (prior?.responseStatusCode && prior.responseJson) {
      ctx.req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId };
      ctx.reply.status(prior.responseStatusCode);
      return prior.responseJson;
    }
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelReplayDenied();
  }

  let subjectId: string | null = null;
  let spaceId: string | null = null;
  let resolvedChatId = channelChatId || null;

  if (channelUserId) {
    const acc = await getChannelAccount({ pool: ctx.app.db, tenantId, provider: "discord", workspaceId: appId, channelUserId });
    if (acc && acc.status === "active") {
      subjectId = acc.subjectId;
      spaceId = acc.spaceId ?? null;
    }
  }
  if (!subjectId && channelChatId) {
    const binding = await getChannelChatBinding({ pool: ctx.app.db, tenantId, provider: "discord", workspaceId: appId, channelChatId });
    if (binding && binding.status === "active") {
      subjectId = binding.defaultSubjectId ?? null;
      spaceId = binding.spaceId;
      resolvedChatId = binding.channelChatId;
    }
  }

  if (!subjectId || !spaceId || !resolvedChatId) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    const err = Errors.channelMappingMissing();
    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "denied", errorCode: err.errorCode };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "discord",
      workspaceId: appId,
      channelChatId: resolvedChatId ?? "unknown",
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "denied",
      messageJson: { errorCode: err.errorCode, message: err.messageI18n },
    });
    throw err;
  }

  ctx.req.ctx.subject = { subjectId, tenantId, spaceId };
  const decision = await requirePermission({ req: ctx.req, resourceType: "orchestrator", action: "turn" });
  ctx.req.ctx.audit!.policyDecision = decision;

  const received = await insertOutboxMessage({
    pool: ctx.app.db,
    tenantId,
    provider: "discord",
    workspaceId: appId,
    channelChatId: resolvedChatId,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "processing",
    messageJson: { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "processing" },
  });

  try {
    const conversationId = channelConversationId({ provider: "discord", workspaceId: appId, channelChatId: resolvedChatId, threadId: null });
    const out = await orchestrateChatTurn({
      app: ctx.app,
      pool: ctx.app.db,
      subject: { subjectId, tenantId, spaceId },
      message: msgText,
      locale: ctx.req.ctx.locale,
      conversationId,
      authorization: null,
      traceId: ctx.req.ctx.traceId,
    });
    const replyText = toReplyText(ctx.req.ctx.locale, out);

    const respBody = { type: 4, data: { content: replyText } };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: respBody });
    const sent = await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "discord",
      workspaceId: appId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "succeeded",
      messageJson: respBody,
    });
    await markOutboxDelivered({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    await markOutboxAcked({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    ctx.req.ctx.audit!.outputDigest = { status: "succeeded", provider: "discord", workspaceId: appId, eventId, outboxId: received.id };
    return respBody;
  } catch (e: any) {
    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "failed" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "discord",
      workspaceId: appId,
      channelChatId: resolvedChatId ?? "unknown",
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "failed",
      messageJson: resp,
    });
    throw e;
  }
}
