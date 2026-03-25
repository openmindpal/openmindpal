import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { setAuditContext } from "../../../modules/audit/context";
import { requirePermission } from "../../../modules/auth/guard";
import { orchestrateChatTurn } from "../../orchestrator/modules/orchestrator";
import { decryptSecretPayload } from "../../../modules/secrets/envelope";
import { getSecretRecordEncryptedPayload } from "../../../modules/secrets/secretRepo";
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
import { sha256Hex, stableStringify } from "./ingressDigest";
import { feishuSendTextToChatWithRetry, getFeishuTenantAccessToken } from "./feishu";
import { channelConversationId } from "./conversationId";

function toTextPayload(raw: unknown) {
  if (typeof raw !== "string") return "";
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && typeof (j as any).text === "string") return String((j as any).text);
  } catch {}
  return raw;
}

async function resolveChannelSecretPayload(params: { app: any; tenantId: string; spaceId: string | null; secretId: string }) {
  const secret = await getSecretRecordEncryptedPayload(params.app.db, params.tenantId, params.secretId);
  if (!secret) throw Errors.badRequest("Secret 不存在");
  if (secret.secret.status !== "active") throw Errors.badRequest("Secret 未激活");
  if (params.spaceId && (secret.secret.scopeType !== "space" || secret.secret.scopeId !== params.spaceId)) throw Errors.forbidden();

  try {
    const decrypted = await decryptSecretPayload({
      pool: params.app.db,
      tenantId: params.tenantId,
      masterKey: params.app.cfg.secrets.masterKey,
      scopeType: secret.secret.scopeType,
      scopeId: secret.secret.scopeId,
      keyVersion: secret.secret.keyVersion,
      encFormat: secret.secret.encFormat,
      encryptedPayload: secret.encryptedPayload,
    });
    return decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg === "key_disabled") throw Errors.keyDisabled();
    throw Errors.keyDecryptFailed();
  }
}

export async function testFeishuConfig(params: { app: any; tenantId: string; cfg: any }) {
  const cfg = params.cfg;
  const secretPayload = cfg.secretId
    ? await resolveChannelSecretPayload({ app: params.app, tenantId: params.tenantId, spaceId: cfg.spaceId ?? null, secretId: String(cfg.secretId) })
    : {};
  const tokenExpected =
    (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") || (typeof (secretPayload as any).verifyToken === "string" ? String((secretPayload as any).verifyToken) : "");
  if (!tokenExpected) throw Errors.channelConfigMissing();

  const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
  const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
  const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
  const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
  const appId =
    (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") || (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "");
  const appSecret =
    (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") || (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "");
  if (!appId || !appSecret) throw Errors.channelConfigMissing();
  await getFeishuTenantAccessToken({ baseUrl, appId, appSecret });
  return { ok: true, baseUrl, hasVerifyToken: true, hasAppCreds: true };
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

export async function handleFeishuEvents(ctx: { app: any; req: any; reply: any }) {
  const body = z.any().parse(ctx.req.body);
  setAuditContext(ctx.req, { resourceType: "channel", action: "feishu.ingress" });

  const tenantId = (ctx.req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
  const tsRaw = (ctx.req.headers["x-lark-request-timestamp"] as string | undefined) ?? "";
  const nonce = ((ctx.req.headers["x-lark-request-nonce"] as string | undefined) ?? "").trim();
  const timestampSec = tsRaw ? Number(tsRaw) : NaN;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

  const typ = String(body?.type ?? "");
  const workspaceId = String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim();
  if (!workspaceId) throw Errors.badRequest("workspaceId 缺失");
  const cfg = await getWebhookConfig({ pool: ctx.app.db, tenantId, provider: "feishu", workspaceId });
  if (!cfg) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }
  if (Math.abs(now - timestampSec) > cfg.toleranceSec) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelReplayDenied();
  }

  const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app: ctx.app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
  const tokenExpected =
    (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") || (typeof (secretPayload as any).verifyToken === "string" ? String((secretPayload as any).verifyToken) : "");
  if (!tokenExpected) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }
  const tokenActual = String(body?.token ?? body?.header?.token ?? "");
  if (!tokenActual || tokenActual !== tokenExpected) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelSignatureInvalid();
  }

  if (typ === "url_verification") {
    const challenge = String(body?.challenge ?? "");
    if (!challenge) throw Errors.badRequest("challenge 缺失");
    ctx.req.ctx.audit!.outputDigest = { provider: "feishu", workspaceId, type: typ };
    return { challenge };
  }

  const eventId = String(body?.header?.event_id ?? "").trim();
  if (!eventId) throw Errors.badRequest("eventId 缺失");
  const channelChatId = String(body?.event?.message?.chat_id ?? "").trim();
  const channelUserId = String(body?.event?.sender?.sender_id?.open_id ?? body?.event?.sender?.sender_id?.user_id ?? "").trim();
  const msgText = toTextPayload(body?.event?.message?.content);

  const payloadForDigest = {
    provider: "feishu",
    workspaceId,
    eventId,
    timestamp: timestampSec,
    nonce: nonce || eventId,
    channelUserId: channelUserId || null,
    channelChatId: channelChatId || null,
    text: msgText || null,
    payload: body ?? null,
  };
  const bodyDigest = sha256Hex(stableStringify(payloadForDigest));

  const inserted = await insertIngressEvent({
    pool: ctx.app.db,
    tenantId,
    provider: "feishu",
    workspaceId,
    eventId,
    nonce: nonce || eventId,
    bodyDigest,
    bodyJson: payloadForDigest,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "received",
  });

  if (!inserted) {
    const prior = await getIngressEvent({ pool: ctx.app.db, tenantId, provider: "feishu", workspaceId, eventId });
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
    const acc = await getChannelAccount({ pool: ctx.app.db, tenantId, provider: "feishu", workspaceId, channelUserId });
    if (acc && acc.status === "active") {
      subjectId = acc.subjectId;
      spaceId = acc.spaceId ?? null;
    }
  }
  if (!subjectId && channelChatId) {
    const binding = await getChannelChatBinding({ pool: ctx.app.db, tenantId, provider: "feishu", workspaceId, channelChatId });
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
      provider: "feishu",
      workspaceId,
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
    provider: "feishu",
    workspaceId,
    channelChatId: resolvedChatId,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "processing",
    messageJson: { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "processing" },
  });

  try {
    const conversationId = channelConversationId({ provider: "feishu", workspaceId, channelChatId: resolvedChatId, threadId: null });
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
    const replyText = pickI18nText(ctx.req.ctx.locale, (out as any)?.replyText);

    const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
    const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
    const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
    const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
    const appId =
      (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") || (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "");
    const appSecret =
      (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") || (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "");
    if (appId && appSecret) {
      const accessToken = await getFeishuTenantAccessToken({ baseUrl, appId, appSecret });
      await feishuSendTextToChatWithRetry({
        baseUrl,
        tenantAccessToken: accessToken,
        chatId: resolvedChatId,
        text: replyText,
        maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
        backoffMsBase: Number(cfg.backoffMsBase ?? 200),
      });
    }

    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "succeeded" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
    const sent = await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "feishu",
      workspaceId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "succeeded",
      messageJson: resp,
    });
    await markOutboxDelivered({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    await markOutboxAcked({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    ctx.req.ctx.audit!.outputDigest = { status: "succeeded", provider: "feishu", workspaceId, eventId, outboxId: received.id };
    return resp;
  } catch (e: any) {
    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "failed" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: "feishu",
      workspaceId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "failed",
      messageJson: resp,
    });
    throw e;
  }
}
