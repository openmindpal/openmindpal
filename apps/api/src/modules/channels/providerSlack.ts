import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../audit/context";
import { requirePermission } from "../auth/guard";
import { orchestrateChatTurn } from "../orchestrator/orchestrator";
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
import { resolveChannelSecretPayload } from "./channelSecret";
import { channelConversationId } from "./conversationId";
import { slackSendTextWithRetry, verifySlackSignature } from "./slack";

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

export async function handleSlackEvents(ctx: { app: any; req: any; reply: any }) {
  const rawBody = typeof ctx.req.body === "string" ? ctx.req.body : JSON.stringify(ctx.req.body ?? {});
  const body = z.any().parse(JSON.parse(rawBody));

  setAuditContext(ctx.req, { resourceType: "channel", action: "slack.ingress" });
  const tenantId = (ctx.req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";

  const teamId = String(body?.team_id ?? "").trim();
  if (!teamId) throw Errors.badRequest("workspaceId 缺失");
  const cfg = await getWebhookConfig({ pool: ctx.app.db, tenantId, provider: "slack", workspaceId: teamId });
  if (!cfg) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }

  const tsRaw = String((ctx.req.headers["x-slack-request-timestamp"] as string | undefined) ?? "");
  const timestampSec = tsRaw ? Number(tsRaw) : NaN;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");
  if (Math.abs(now - timestampSec) > cfg.toleranceSec) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelReplayDenied();
  }

  const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app: ctx.app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
  const signingSecret = pickSecret(secretPayload, "slackSigningSecret");
  if (!signingSecret) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }
  const sigHeader = String((ctx.req.headers["x-slack-signature"] as string | undefined) ?? "");
  verifySlackSignature({ signingSecret, timestampSec: Math.floor(timestampSec), rawBody, signatureHeader: sigHeader });

  const typ = String(body?.type ?? "");
  if (typ === "url_verification") {
    const challenge = String(body?.challenge ?? "");
    if (!challenge) throw Errors.badRequest("challenge 缺失");
    ctx.req.ctx.audit!.outputDigest = { provider: "slack", workspaceId: teamId, type: typ };
    return { challenge };
  }

  const eventId = String(body?.event_id ?? "").trim();
  if (!eventId) throw Errors.badRequest("eventId 缺失");
  const ev = body?.event ?? {};
  const channelChatId = String(ev?.channel ?? "").trim();
  const channelUserId = String(ev?.user ?? "").trim();
  const msgText = typeof ev?.text === "string" ? String(ev.text) : "";

  const bodyDigest = computeBridgeBodyDigest({
    provider: "slack",
    workspaceId: teamId,
    eventId,
    timestampSec: Math.floor(timestampSec),
    channelChatId: channelChatId || null,
    channelUserId: channelUserId || null,
    text: msgText || null,
    payload: body ?? null,
  });

  const inserted = await insertIngressEvent({
    pool: ctx.app.db,
    tenantId,
    provider: "slack",
    workspaceId: teamId,
    eventId,
    nonce: String((body?.event_time ?? timestampSec) ?? timestampSec),
    bodyDigest,
    bodyJson: body,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "received",
  });

  if (!inserted) {
    const prior = await getIngressEvent({ pool: ctx.app.db, tenantId, provider: "slack", workspaceId: teamId, eventId });
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
    const acc = await getChannelAccount({ pool: ctx.app.db, tenantId, provider: "slack", workspaceId: teamId, channelUserId });
    if (acc && acc.status === "active") {
      subjectId = acc.subjectId;
      spaceId = acc.spaceId ?? null;
    }
  }
  if (!subjectId && channelChatId) {
    const binding = await getChannelChatBinding({ pool: ctx.app.db, tenantId, provider: "slack", workspaceId: teamId, channelChatId });
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
      provider: "slack",
      workspaceId: teamId,
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
    provider: "slack",
    workspaceId: teamId,
    channelChatId: resolvedChatId,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "processing",
    messageJson: { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "processing" },
  });

  try {
    const conversationId = channelConversationId({ provider: "slack", workspaceId: teamId, channelChatId: resolvedChatId, threadId: null });
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
    const botToken = pickSecret(secretPayload, "slackBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    await slackSendTextWithRetry({
      botToken,
      channel: resolvedChatId,
      text: replyText,
      maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
      backoffMsBase: Number(cfg.backoffMsBase ?? 200),
    });

    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "succeeded" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
    const sent = await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "slack",
      workspaceId: teamId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "succeeded",
      messageJson: resp,
    });
    await markOutboxDelivered({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    await markOutboxAcked({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    ctx.req.ctx.audit!.outputDigest = { status: "succeeded", provider: "slack", workspaceId: teamId, eventId, outboxId: received.id };
    return resp;
  } catch (e: any) {
    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "failed" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "slack",
      workspaceId: teamId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "failed",
      messageJson: resp,
    });
    throw e;
  }
}
