import { z } from "zod";
import { Errors } from "../../lib/errors";
import { redactString, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "@openslin/shared";
import { setAuditContext } from "../audit/context";
import { requirePermission } from "../auth/guard";
import { orchestrateChatTurn } from "../orchestrator/orchestrator";
import { extractTextForPromptInjectionScan, getPromptInjectionDenyTargetsFromEnv, getPromptInjectionModeFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../safety/promptInjectionGuard";
import { bridgeSendWithRetry } from "./bridgeSend";
import { computeBridgeBodyDigest, verifyBridgeSignature } from "./bridgeContract";
import { resolveChannelSecretPayload } from "./channelSecret";
import { channelConversationId } from "./conversationId";
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

type BridgeMessageBody = {
  provider: string;
  workspaceId: string;
  eventId: string;
  timestampMs: number;
  nonce: string;
  type: "message";
  channelChatId: string;
  channelUserId: string;
  bridgeMessageId?: string;
  text?: string;
  attachments?: any[];
  raw?: any;
};

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

async function sendViaWebhook(params: { webhookUrl: string; text: string; headers?: Record<string, string> }) {
  const res = await fetch(params.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(params.headers ?? {}) },
    body: JSON.stringify({ text: params.text, content: params.text }),
  });
  if (!res.ok) throw Errors.badRequest("webhook_send_failed");
}

async function sendViaSlack(params: { botToken: string; channel: string; text: string }) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${params.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: params.channel, text: params.text }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Errors.badRequest("slack_send_failed");
  if (json && typeof json === "object" && (json as any).ok === false) throw Errors.badRequest("slack_send_error");
}

function pickSecret(payload: Record<string, unknown>, key: string) {
  const v = payload[key];
  return typeof v === "string" ? String(v) : "";
}

function dlpRuleIdsFromSummary(summary: { hitCounts?: Record<string, number> }) {
  const hitCounts = summary?.hitCounts ?? {};
  const out: string[] = [];
  if ((hitCounts.token ?? 0) > 0) out.push("dlp.token");
  if ((hitCounts.email ?? 0) > 0) out.push("dlp.email");
  if ((hitCounts.phone ?? 0) > 0) out.push("dlp.phone");
  return out;
}

export async function handleBridgeEvents(ctx: { app: any; req: any; reply: any }, opts?: { expectedProvider?: string }) {
  const body = z
    .object({
      provider: z.string().min(1),
      workspaceId: z.string().min(1),
      eventId: z.string().min(1),
      timestampMs: z.number().int().positive(),
      nonce: z.string().min(1),
      type: z.literal("message"),
      channelChatId: z.string().min(1),
      channelUserId: z.string().min(1),
      bridgeMessageId: z.string().min(1).optional(),
      text: z.string().max(20000).optional(),
      attachments: z.array(z.any()).optional(),
      raw: z.any().optional(),
    })
    .parse(ctx.req.body) as BridgeMessageBody;

  if (opts?.expectedProvider && body.provider !== opts.expectedProvider) throw Errors.badRequest("provider 不匹配");

  setAuditContext(ctx.req, { resourceType: "channel", action: "bridge.ingress" });
  const tenantId = (ctx.req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";

  const cfg = await getWebhookConfig({ pool: ctx.app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId });
  if (!cfg) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }

  const nowMs = Date.now();
  if (Math.abs(nowMs - body.timestampMs) > cfg.toleranceSec * 1000) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelReplayDenied();
  }

  const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app: ctx.app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
  const webhookSecret = (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") || pickSecret(secretPayload, "webhookSecret");
  if (!webhookSecret) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }

  const signature = String((ctx.req.headers["x-bridge-signature"] as string | undefined) ?? "");
  const nonceHeader = String((ctx.req.headers["x-bridge-nonce"] as string | undefined) ?? "");
  const tsHeader = Number((ctx.req.headers["x-bridge-timestamp"] as string | undefined) ?? "");
  if (!nonceHeader || !Number.isFinite(tsHeader)) throw Errors.badRequest("bridge headers 缺失");
  if (nonceHeader !== body.nonce || tsHeader !== body.timestampMs) throw Errors.badRequest("bridge headers/body 不一致");

  const bodyDigest = computeBridgeBodyDigest(body);
  verifyBridgeSignature({ secret: webhookSecret, timestampMs: body.timestampMs, nonce: body.nonce, eventId: body.eventId, bodyDigest, signature });

  const inserted = await insertIngressEvent({
    pool: ctx.app.db,
    tenantId,
    provider: body.provider,
    workspaceId: body.workspaceId,
    eventId: body.eventId,
    nonce: body.nonce,
    bodyDigest,
    bodyJson: body,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "received",
  });

  if (!inserted) {
    const prior = await getIngressEvent({ pool: ctx.app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId });
    if (prior?.responseStatusCode && prior.responseJson) {
      ctx.req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: body.eventId };
      ctx.reply.status(prior.responseStatusCode);
      return prior.responseJson;
    }
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelReplayDenied();
  }

  let subjectId: string | null = null;
  let spaceId: string | null = null;
  let resolvedChatId = body.channelChatId;

  const acc = await getChannelAccount({ pool: ctx.app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId });
  if (acc && acc.status === "active") {
    subjectId = acc.subjectId;
    spaceId = acc.spaceId ?? null;
  }
  if (!subjectId) {
    const binding = await getChannelChatBinding({ pool: ctx.app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId });
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
      provider: body.provider,
      workspaceId: body.workspaceId,
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
  const piMode = getPromptInjectionModeFromEnv();
  const piDenyTargets = getPromptInjectionDenyTargetsFromEnv();
  const piTarget = "channel:send";
  const piText = extractTextForPromptInjectionScan(body.text ?? "");
  const piScan = scanPromptInjection(piText);
  const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, mode: piMode, target: piTarget, denyTargets: piDenyTargets });
  const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
  if (piDenied) {
    ctx.req.ctx.audit!.errorCategory = "policy_violation";
    const err = Errors.safetyPromptInjectionDenied();
    const resp = {
      correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId },
      status: "denied" as const,
      errorCode: err.errorCode,
      safetySummary: { decision: "denied" as const, target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
    };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "denied",
      messageJson: { errorCode: err.errorCode, message: err.messageI18n },
    });
    ctx.req.ctx.audit!.outputDigest = resp;
    return ctx.reply.status(403).send(resp);
  }

  const received = await insertOutboxMessage({
    pool: ctx.app.db,
    tenantId,
    provider: body.provider,
    workspaceId: body.workspaceId,
    channelChatId: resolvedChatId,
    requestId: ctx.req.ctx.requestId,
    traceId: ctx.req.ctx.traceId,
    status: "processing",
    messageJson: { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "processing" },
  });

  try {
    const conversationId = channelConversationId({ provider: body.provider, workspaceId: body.workspaceId, channelChatId: resolvedChatId, threadId: null });
    const out = await orchestrateChatTurn({
      app: ctx.app,
      pool: ctx.app.db,
      subject: { subjectId, tenantId, spaceId },
      message: body.text ?? "",
      locale: ctx.req.ctx.locale,
      conversationId,
      authorization: null,
      traceId: ctx.req.ctx.traceId,
    });
    const replyText = toReplyText(ctx.req.ctx.locale, out);
    const dlpPolicy = resolveDlpPolicyFromEnv(process.env);
    const dlpTarget = "channel:send";
    const dlp = redactString(replyText);
    const dlpDenied = shouldDenyDlpForTarget({ summary: dlp.summary, target: dlpTarget, policy: dlpPolicy });
    const dlpRuleIds = dlpRuleIdsFromSummary(dlp.summary);
    const egressDlpSummary = dlpDenied
      ? {
          ...dlp.summary,
          disposition: "deny" as const,
          redacted: true,
          mode: dlpPolicy.mode,
          policyVersion: dlpPolicy.version,
          target: dlpTarget,
          decision: "denied" as const,
          ruleIds: dlpRuleIds,
        }
      : dlp.summary.redacted
        ? {
            ...dlp.summary,
            disposition: "redact" as const,
            mode: dlpPolicy.mode,
            policyVersion: dlpPolicy.version,
            target: dlpTarget,
            decision: "allowed" as const,
            ruleIds: dlpRuleIds,
          }
        : {
            ...dlp.summary,
            mode: dlpPolicy.mode,
            policyVersion: dlpPolicy.version,
            target: dlpTarget,
            decision: "allowed" as const,
            ruleIds: dlpRuleIds,
          };
    const safeReplyText = dlp.value;
    if (dlpDenied) {
      ctx.req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.dlpDenied();
      const resp = {
        correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId },
        status: "denied" as const,
        errorCode: err.errorCode,
        safetySummary: { decision: "denied" as const, target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      };
      await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
      await insertOutboxMessage({
        pool: ctx.app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId: resolvedChatId,
        requestId: ctx.req.ctx.requestId,
        traceId: ctx.req.ctx.traceId,
        status: "denied",
        messageJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      ctx.req.ctx.audit!.outputDigest = {
        status: "denied",
        provider: body.provider,
        workspaceId: body.workspaceId,
        eventId: body.eventId,
        outboxId: received.id,
        safetySummary: { decision: "denied", target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      };
      throw err;
    }

    const baseUrl = pickSecret(secretPayload, "bridgeBaseUrl");
    const webhookUrl = pickSecret(secretPayload, "webhookUrl");
    const slackBotToken = pickSecret(secretPayload, "slackBotToken");
    if (body.provider === "qq.onebot" || body.provider === "imessage.bridge") {
      if (!baseUrl) throw Errors.channelConfigMissing();
      await bridgeSendWithRetry({
        baseUrl,
        secret: webhookSecret,
        provider: body.provider,
        workspaceId: body.workspaceId,
        requestId: ctx.req.ctx.requestId,
        traceId: ctx.req.ctx.traceId,
        to: { channelChatId: resolvedChatId },
        message: { text: safeReplyText },
        idempotencyKey: `outbox_${received.id}`,
        maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
        backoffMsBase: Number(cfg.backoffMsBase ?? 200),
      });
    } else if (slackBotToken) {
      await sendViaSlack({ botToken: slackBotToken, channel: resolvedChatId, text: safeReplyText });
    } else if (webhookUrl) {
      await sendViaWebhook({ webhookUrl, text: safeReplyText });
    } else {
      throw Errors.channelConfigMissing();
    }

    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "succeeded" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
    const sent = await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "succeeded",
      messageJson: resp,
    });
    await markOutboxDelivered({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    await markOutboxAcked({ pool: ctx.app.db, tenantId, ids: [sent.id, received.id] });
    ctx.req.ctx.audit!.outputDigest = {
      status: "succeeded",
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      outboxId: received.id,
      safetySummary: { decision: "allowed", target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      egress: { target: dlpTarget, redacted: Boolean(egressDlpSummary.redacted) },
    };
    return resp;
  } catch (e: any) {
    const resp = { correlation: { requestId: ctx.req.ctx.requestId, traceId: ctx.req.ctx.traceId }, status: "failed" as const };
    await finalizeIngressEvent({ pool: ctx.app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
    await insertOutboxMessage({
      pool: ctx.app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: resolvedChatId,
      requestId: ctx.req.ctx.requestId,
      traceId: ctx.req.ctx.traceId,
      status: "failed",
      messageJson: resp,
    });
    throw e;
  }
}
