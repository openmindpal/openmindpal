import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";
import { AppError, Errors } from "../../lib/errors";
import { getToolDefinition, getToolVersionByRef } from "../tools/toolRepo";
import { resolveEffectiveToolRef } from "../tools/resolve";
import { validateToolInput } from "../tools/validate";
import { isToolEnabled } from "../governance/toolGovernanceRepo";
import type { OrchestratorTurnRequest, OrchestratorTurnResponse } from "./model";
import { getSessionContext, upsertSessionContext, type SessionMessage } from "../memory/sessionContextRepo";

function hasAny(text: string, keywords: string[]) {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

function defaultNotesDraft() {
  return {
    schemaName: "core",
    entityName: "notes",
    payload: {
      title: "",
    },
  };
}

function buildKnowledgeQueryDraft(msg: string) {
  let q = msg.trim();
  q = q.replaceAll("知识库", "").replaceAll("knowledge base", "").replaceAll("knowledge", "");
  q = q.replaceAll("搜索", "").replaceAll("查找", "").replaceAll("检索", "").replaceAll("查询", "").replaceAll("search", "").replaceAll("find", "");
  q = q.trim();
  if (!q) q = msg.trim();
  q = q.slice(0, 200);
  return { query: q, limit: 10 };
}

function pruneDraftByInputSchema(inputSchema: any, draft: any) {
  const fields = inputSchema?.fields;
  if (!fields || !draft || typeof draft !== "object" || Array.isArray(draft)) return draft;
  const allowed = new Set(Object.keys(fields));
  const out: any = {};
  for (const k of Object.keys(draft)) {
    if (allowed.has(k)) out[k] = (draft as any)[k];
  }
  return out;
}

export async function orchestrateTurn(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string;
  message: OrchestratorTurnRequest["message"];
}) {
  const msg = params.message.trim();
  const toolSuggestions: any[] = [];
  let uiDirective: OrchestratorTurnResponse["uiDirective"] | undefined;

  if (params.spaceId && hasAny(msg, ["search", "find", "lookup", "查找", "搜索", "检索", "查询", "知识库"])) {
    const toolRef = await resolveEffectiveToolRef({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? null, name: "knowledge.search" });
    if (toolRef) {
      const enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef });
      if (enabled) {
        const ver = await getToolVersionByRef(params.pool, params.tenantId, toolRef);
        if (!ver) throw Errors.badRequest("工具版本不存在");
        const def = await getToolDefinition(params.pool, params.tenantId, "knowledge.search");
        const inputDraft = pruneDraftByInputSchema(ver.inputSchema, buildKnowledgeQueryDraft(msg));
        try {
          validateToolInput(ver.inputSchema, inputDraft);
          toolSuggestions.push({
            toolRef,
            inputDraft,
            scope: def?.scope ?? "read",
            resourceType: def?.resourceType ?? "knowledge",
            action: def?.action ?? "search",
            riskLevel: def?.riskLevel ?? "low",
            approvalRequired: def?.approvalRequired ?? false,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch {
          throw Errors.badRequest("工具入参草稿不合法");
        }
      }
    }
  }

  if (hasAny(msg, ["open", "show", "list", "view", "打开", "查看", "列表", "进入", "去"])) {
    if (hasAny(msg, ["note", "notes", "笔记"])) {
      uiDirective = {
        openView: "page",
        viewParams: { name: "notes.list" },
        openMode: "page",
      };
    }
  }

  if (hasAny(msg, ["create", "new", "add", "insert", "新建", "创建", "新增"])) {
    if (hasAny(msg, ["note", "notes", "笔记"])) {
      const toolRef = await resolveEffectiveToolRef({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? null, name: "entity.create" });
      if (toolRef) {
        const ver = await getToolVersionByRef(params.pool, params.tenantId, toolRef);
        if (!ver) throw Errors.badRequest("工具版本不存在");
        const def = await getToolDefinition(params.pool, params.tenantId, "entity.create");
        const inputDraft = pruneDraftByInputSchema(ver.inputSchema, defaultNotesDraft());
        try {
          validateToolInput(ver.inputSchema, inputDraft);
          toolSuggestions.push({
            toolRef,
            inputDraft,
            scope: def?.scope ?? "write",
            resourceType: def?.resourceType ?? "entity",
            action: def?.action ?? "create",
            riskLevel: def?.riskLevel ?? "high",
            approvalRequired: def?.approvalRequired ?? true,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch {
          throw Errors.badRequest("工具入参草稿不合法");
        }
      }
    }
  }

  if (params.spaceId && toolSuggestions.length === 0) {
    const toolRef = await resolveEffectiveToolRef({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? null, name: "knowledge.search" });
    if (toolRef) {
      const enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef });
      if (enabled) {
        const ver = await getToolVersionByRef(params.pool, params.tenantId, toolRef);
        if (!ver) throw Errors.badRequest("工具版本不存在");
        const def = await getToolDefinition(params.pool, params.tenantId, "knowledge.search");
        const inputDraft = pruneDraftByInputSchema(ver.inputSchema, buildKnowledgeQueryDraft(msg));
        try {
          validateToolInput(ver.inputSchema, inputDraft);
          toolSuggestions.push({
            toolRef,
            inputDraft,
            scope: def?.scope ?? "read",
            resourceType: def?.resourceType ?? "knowledge",
            action: def?.action ?? "search",
            riskLevel: def?.riskLevel ?? "low",
            approvalRequired: def?.approvalRequired ?? false,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch {
          throw Errors.badRequest("工具入参草稿不合法");
        }
      }
    }
    if (toolSuggestions.length === 0) {
      const toolRef2 = await resolveEffectiveToolRef({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? null, name: "entity.create" });
      if (toolRef2) {
        const ver2 = await getToolVersionByRef(params.pool, params.tenantId, toolRef2);
        if (!ver2) throw Errors.badRequest("工具版本不存在");
        const def2 = await getToolDefinition(params.pool, params.tenantId, "entity.create");
        const inputDraft2 = pruneDraftByInputSchema(ver2.inputSchema, defaultNotesDraft());
        try {
          validateToolInput(ver2.inputSchema, inputDraft2);
          toolSuggestions.push({
            toolRef: toolRef2,
            inputDraft: inputDraft2,
            scope: def2?.scope ?? "write",
            resourceType: def2?.resourceType ?? "entity",
            action: def2?.action ?? "create",
            riskLevel: def2?.riskLevel ?? "high",
            approvalRequired: def2?.approvalRequired ?? true,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch {
          throw Errors.badRequest("工具入参草稿不合法");
        }
      }
    }
  }

  const replyText =
    toolSuggestions.length || uiDirective
      ? { "zh-CN": "已生成建议。", "en-US": "Suggestions generated." }
      : { "zh-CN": "未找到可用建议。", "en-US": "No suggestion found." };

  const res: OrchestratorTurnResponse = {
    replyText,
    toolSuggestions,
    uiDirective,
  };
  return res;
}

type Subject = { tenantId: string; spaceId?: string; subjectId: string };

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function conversationWindowSize() {
  const raw = Number(process.env.ORCHESTRATOR_CONVERSATION_WINDOW ?? "16");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 16, 4, 64);
}

function conversationTtlMs() {
  const rawDays = Number(process.env.ORCHESTRATOR_CONVERSATION_TTL_DAYS ?? "7");
  const days = clampInt(Number.isFinite(rawDays) ? Math.floor(rawDays) : 7, 1, 30);
  return days * 24 * 60 * 60 * 1000;
}

function base64UrlEncode(buf: Buffer) {
  return buf.toString("base64url");
}

function makeInternalAuthHeader(subject: Subject) {
  const mode =
    process.env.AUTHN_MODE === "pat"
      ? "pat"
      : process.env.AUTHN_MODE === "hmac"
        ? "hmac"
        : "dev";
  if (mode === "dev") {
    const space = subject.spaceId ?? "space_dev";
    return `Bearer ${subject.subjectId}@${space}`;
  }
  if (mode === "hmac") {
    const secret = String(process.env.AUTHN_HMAC_SECRET ?? "");
    if (!secret) return "";
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const payload = { tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null, exp };
    const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
    const sigPart = base64UrlEncode(sig);
    return `Bearer ${payloadPart}.${sigPart}`;
  }
  return "";
}

async function invokeModelChat(params: {
  app: FastifyInstance;
  subject: Subject;
  locale: string;
  authorization?: string | null;
  traceId?: string | null;
  purpose: string;
  messages: { role: string; content: string }[];
  timeoutMs?: number;
}) {
  const auth = (params.authorization ?? "").trim() || makeInternalAuthHeader(params.subject);
  if (!auth) throw new AppError({ errorCode: "AUTH_UNAUTHORIZED", httpStatus: 401, message: { "zh-CN": "未认证", "en-US": "Unauthorized" } });

  const res = await params.app.inject({
    method: "POST",
    url: "/models/chat",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      "x-user-locale": params.locale,
      ...(params.traceId ? { "x-trace-id": params.traceId } : {}),
    },
    payload: { purpose: params.purpose, messages: params.messages, timeoutMs: params.timeoutMs },
  });
  const body = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode >= 200 && res.statusCode < 300) return body as any;
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : "MODEL_CHAT_FAILED";
  const message =
    body?.message && typeof body.message === "object"
      ? body.message
      : { "zh-CN": String(body?.message ?? "模型调用失败"), "en-US": String(body?.message ?? "Model invocation failed") };
  throw new AppError({ errorCode, httpStatus: res.statusCode || 500, message });
}

export async function orchestrateChatTurn(params: {
  app: FastifyInstance;
  pool: Pool;
  subject: Subject;
  message: string;
  locale?: string;
  conversationId?: string | null;
  authorization?: string | null;
  traceId?: string | null;
}) {
  const locale = (params.locale ?? "zh-CN").trim() || "zh-CN";
  const msg = params.message.trim();
  if (!msg) throw Errors.badRequest("message 为空");

  const base = await orchestrateTurn({ pool: params.pool, tenantId: params.subject.tenantId, spaceId: params.subject.spaceId, message: msg });
  const conversationId = (params.conversationId ?? "").trim() || crypto.randomUUID();

  const spaceId = params.subject.spaceId ?? "";
  const historyLimit = conversationWindowSize();
  const nowIso = new Date().toISOString();
  const redactedMsg = redactValue(msg);
  const userContent = String(redactedMsg.value ?? "");

  const prev =
    spaceId
      ? await getSessionContext({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, subjectId: params.subject.subjectId, sessionId: conversationId })
      : null;
  const prevMsgs = Array.isArray(prev?.context?.messages) ? prev!.context.messages : [];
  const clippedPrev = prevMsgs.slice(Math.max(0, prevMsgs.length - (historyLimit - 2)));

  const modelMessages: { role: string; content: string }[] = [
    { role: "system", content: "You are a helpful assistant. Follow user locale when replying." },
    ...clippedPrev
      .filter((m: any) => m && typeof m === "object")
      .map((m: any) => ({ role: String(m.role ?? "user"), content: String(m.content ?? "") }))
      .filter((m: any) => m.content),
    { role: "user", content: userContent },
  ];

  let outputText = "";
  try {
    const modelOut = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale,
      authorization: params.authorization,
      traceId: params.traceId,
      purpose: "orchestrator.turn",
      messages: modelMessages,
    });
    outputText = typeof modelOut?.outputText === "string" ? modelOut.outputText : "";
  } catch {
    outputText = "";
  }

  const baseReply =
    typeof base.replyText === "string"
      ? base.replyText
      : base.replyText && typeof base.replyText === "object"
        ? String((base.replyText as any)[locale] ?? (base.replyText as any)["zh-CN"] ?? Object.values(base.replyText as any)[0] ?? "")
        : "";
  const replyText = outputText.trim() || baseReply;

  if (spaceId) {
    function coerceRole(v: any): "user" | "assistant" | "system" {
      const r = String(v ?? "");
      if (r === "assistant" || r === "system" || r === "user") return r;
      return "user";
    }
    const assistantRedacted = redactValue(replyText);
    const assistantContent = String(assistantRedacted.value ?? "");
    const nextMsgs: SessionMessage[] = [
      ...clippedPrev.map((m) => ({ role: coerceRole(m.role), content: String(m.content ?? ""), at: typeof m.at === "string" ? m.at : undefined })).filter((m) => m.content),
      { role: "user", content: userContent, at: nowIso },
      { role: "assistant", content: assistantContent, at: nowIso },
    ];
    const trimmed = nextMsgs.slice(Math.max(0, nextMsgs.length - historyLimit));
    const expiresAt = new Date(Date.now() + conversationTtlMs()).toISOString();
    await upsertSessionContext({
      pool: params.pool,
      tenantId: params.subject.tenantId,
      spaceId,
      subjectId: params.subject.subjectId,
      sessionId: conversationId,
      context: { v: 1, messages: trimmed },
      expiresAt,
    });
  }

  const res: OrchestratorTurnResponse = {
    ...base,
    conversationId,
    replyText,
  };
  return res;
}
