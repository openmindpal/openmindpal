import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";
import { Errors } from "../../../lib/errors";
import { invokeModelChat, parseToolCallsFromOutput, type LlmSubject } from "../../../lib/llm";
import type { OrchestratorTurnRequest, OrchestratorTurnResponse } from "./model";
import { getSessionContext, upsertSessionContext, type SessionMessage } from "../../memory-manager/modules/sessionContextRepo";
import { searchMemory, listRecentTaskStates } from "../../memory-manager/modules/repo";
import { getLatestReleasedToolVersion, listToolDefinitions, getToolVersionByRef, type ToolDefinition, type ToolVersion } from "../../../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../../../modules/tools/resolve";
import { isToolEnabled } from "../../../modules/governance/toolGovernanceRepo";



function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function conversationWindowSize() {
  const raw = Number(process.env.ORCHESTRATOR_CONVERSATION_WINDOW ?? "16");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 16, 4, 64);
}

function memoryRecallLimit() {
  const raw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_LIMIT ?? "5");
  return clampInt(Number.isFinite(raw) ? Math.floor(raw) : 5, 0, 20);
}

const MEMORY_RECALL_MAX_CHARS = 1200;
const TASK_RECALL_MAX_CHARS = 800;
const TASK_RECALL_LIMIT = 5;
const TOOLS_CATALOG_MAX_CHARS = 8000;
const PINNED_TOOL_NAMES = [
  "knowledge.search", "memory.read", "memory.write",
  "nl2ui.generate",
  "entity.create", "entity.update", "entity.delete",
] as const;



/**
 * 记忆召回：用当前消息搜索长期记忆，返回格式化摘要文本。
 * 按 架构-08§7 "检索与记忆写入都必须映射为工具调用" 的精神，
 * 这里作为编排层核心的上下文组装能力，在对话前主动检索记忆。
 * 失败时静默降级（不阻塞对话）。
 */
async function recallRelevantMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  message: string;
}): Promise<string> {
  const limit = memoryRecallLimit();
  if (limit <= 0) return "";
  try {
    const result = await searchMemory({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      query: params.message.slice(0, 200),
      limit,
    });
    const evidence = result.evidence ?? [];
    if (!evidence.length) return "";
    let totalChars = 0;
    const lines: string[] = [];
    for (const e of evidence) {
      const line = `- [${e.type ?? "memory"}] ${e.title ? e.title + ": " : ""}${e.snippet}`;
      if (totalChars + line.length > MEMORY_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * 任务状态召回：查询该空间最近的任务状态，返回格式化摘要。
 * 让模型知道用户最近执行过什么任务，支持跨会话任务关联。
 * 按架构-11§3 TaskState 分层模型 + §4.3 任务状态持久化与恢复。
 * 失败时静默降级。
 */
async function recallRecentTasks(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
}): Promise<string> {
  try {
    const tasks = await listRecentTaskStates({
      pool: params.pool,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      limit: TASK_RECALL_LIMIT,
    });
    if (!tasks.length) return "";
    let totalChars = 0;
    const lines: string[] = [];
    for (const t of tasks) {
      const planSummary = t.plan && typeof t.plan === "object"
        ? (Array.isArray(t.plan.steps) ? `${t.plan.steps.length} steps` : "has plan")
        : "no plan";
      const line = `- [${t.phase}] run=${t.runId.slice(0, 8)}… ${planSummary}, updated=${t.updatedAt}`;
      if (totalChars + line.length > TASK_RECALL_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

export type EnabledTool = { name: string; toolRef: string; def: ToolDefinition; ver: ToolVersion | null };

function i18nText(v: unknown, locale: string): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, string>;
    return String(obj[locale] ?? obj["zh-CN"] ?? Object.values(obj)[0] ?? "");
  }
  return String(v);
}

/**
 * 发现当前空间已启用的工具列表。
 * 查询 tool_definitions → resolveEffectiveToolRef → isToolEnabled → getToolVersionByRef，
 * 仅返回 released + enabled 的工具。
 * 失败时静默降级（不阻塞对话）。
 */
export async function discoverEnabledTools(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  locale: string;
}): Promise<{ catalog: string; tools: EnabledTool[] }> {
  try {
    const defs = await listToolDefinitions(params.pool, params.tenantId);
    if (!defs.length) return { catalog: "", tools: [] };

    const pinned: ToolDefinition[] = [];
    for (const n of PINNED_TOOL_NAMES) {
      const d = defs.find((x) => x.name === n);
      if (d) pinned.push(d);
    }
    const pinnedNameSet = new Set<string>(PINNED_TOOL_NAMES as unknown as string[]);
    const orderedDefs = [...pinned, ...defs.filter((d) => !pinnedNameSet.has(d.name))];

    const enabledTools: EnabledTool[] = [];
    for (const def of orderedDefs) {
      let effRef = await resolveEffectiveToolRef({
        pool: params.pool,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        name: def.name,
      });
      if (!effRef) continue;
      let enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: effRef });
      if (!enabled) {
        const latest = await getLatestReleasedToolVersion(params.pool, params.tenantId, def.name);
        const latestRef = latest?.toolRef ?? null;
        if (latestRef && latestRef !== effRef) {
          const enabled2 = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: latestRef });
          if (enabled2) {
            effRef = latestRef;
            enabled = true;
          }
        }
      }
      if (!enabled) continue;
      const ver = await getToolVersionByRef(params.pool, params.tenantId, effRef);
      if (!ver || ver.status !== "released") continue;
      enabledTools.push({ name: def.name, toolRef: effRef, def, ver });
    }
    if (!enabledTools.length) return { catalog: "", tools: [] };

    let totalChars = 0;
    const lines: string[] = [];
    for (const t of enabledTools) {
      const displayName = i18nText(t.def.displayName, params.locale) || t.name;
      const desc = i18nText(t.def.description, params.locale);
      const inputFields = t.ver?.inputSchema?.fields
        ? Object.entries(t.ver.inputSchema.fields as Record<string, any>)
            .map(([k, v]) => `${k}:${v?.type ?? "string"}${v?.required ? "*" : ""}`)
            .join(", ")
        : "";
      const line = `- ${t.toolRef} | ${displayName}${desc ? ": " + desc : ""}${inputFields ? " | input: {" + inputFields + "}" : ""} | risk=${t.def.riskLevel}`;
      if (totalChars + line.length > TOOLS_CATALOG_MAX_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }
    return { catalog: lines.join("\n"), tools: enabledTools };
  } catch {
    return { catalog: "", tools: [] };
  }
}



function buildSystemPrompt(locale: string, memoryContext: string, taskContext: string, toolCatalog: string): string {
  const parts: string[] = [
    "You are MindPal (灵智), the intelligent agent of an Agent OS / Agent Infrastructure platform.",
    "Your underlying system — the MindPal Agent OS — is a governed agent foundation designed for enterprises and edge environments.",
    "It turns LLM capabilities into controlled, auditable execution in real systems, with built-in RBAC, DLP, approval workflows, changeset-based release/rollback, policy snapshots, and full audit trails.",
    "Core architecture layers: (1) Governance plane — identity, RBAC, safety policies, approvals, audit, release management; (2) Execution plane — tool contracts with versioned schemas, idempotency, workflows, async tasks; (3) Device runtime — edge devices, gateways, robot controllers, desktop executors under the same permission boundary; (4) Knowledge & Memory — RAG with evidence chains, long-term memory, task history; (5) Multi-channel interop — IM/Webhook ingress, reliable outbox, receipts.",
    "The platform is extensible via Skills (sandboxed tool packages with manifest-declared permissions and network policies). Any business domain — enterprise operations, industrial automation, embodied intelligence, smart cities, finance, healthcare, logistics and more — can be served by developing and registering new Skills, without modifying the core platform.",
    "You have access to the user's long-term memory, task history, and a set of platform tools/skills.",
    "Follow user locale when replying. Be concise and helpful.",
    "You CANNOT execute tools directly. You can only suggest tool invocations using the required tool_call block format.",
    "NEVER claim that a tool has been executed or that data has been saved unless the system provides an execution receipt/result.",
    "When suggesting a tool, use conditional language (e.g., 'I can help you save this note by running the tool below') and avoid 'already saved' wording.",

  ];
  if (toolCatalog) {
    parts.push(
      "\n## Available Tools (enabled in current workspace)\n" +
      toolCatalog +
      "\n\nWhen the user's request can be fulfilled by one of the above tools, include a tool suggestion at the END of your reply in this exact format:" +
      '\n```tool_call\n[{"toolRef":"<toolRef>","inputDraft":{<key>:<value>}}]\n```' +
      "\nOnly suggest tools when the user's intent clearly maps to an available tool. Include a brief explanation before the tool_call block." +
      "\nIf no tool is applicable, reply normally without a tool_call block." +
      "\nNEVER fabricate toolRef values — only use toolRef values from the Available Tools list above."
    );
  } else {
    parts.push(
      "\nNo tools are currently enabled in this workspace. You can still help with information, analysis, and suggestions."
    );
  }
  if (memoryContext) {
    parts.push(
      "\n## Recalled Memory\n" +
      memoryContext +
      "\n\nUse the above recalled memory to provide contextually relevant responses."
    );
  }
  if (taskContext) {
    parts.push(
      "\n## Recent Tasks\n" +
      taskContext +
      "\n\nUse the above task history to understand what the user has been working on recently."
    );
  }
  return parts.join("\n");
}

function conversationTtlMs() {
  const rawDays = Number(process.env.ORCHESTRATOR_CONVERSATION_TTL_DAYS ?? "7");
  const days = clampInt(Number.isFinite(rawDays) ? Math.floor(rawDays) : 7, 1, 30);
  return days * 24 * 60 * 60 * 1000;
}

function extractKnowledgeSearchQuery(msg: string) {
  const s = msg.trim();
  const prefixes = ["搜索知识库", "搜索 知识库", "搜索", "查找知识库", "查找", "search knowledge base", "search knowledge", "search"];
  for (const p of prefixes) {
    if (s.toLowerCase().startsWith(p.toLowerCase())) {
      const q = s.slice(p.length).trim();
      return q || s;
    }
  }
  return s;
}

export async function orchestrateChatTurn(params: {
  app: FastifyInstance;
  pool: Pool;
  subject: LlmSubject;
  message: string;
  locale?: string;
  conversationId?: string | null;
  authorization?: string | null;
  traceId?: string | null;
  /** 是否持久化会话上下文（默认 true）。代理/协作/渠道等非对话场景应设为 false */
  persistSession?: boolean;
  /** 是否将模型错误向上传播（默认 false，保持 turn 200 + fallback 文案行为） */
  propagateModelErrors?: boolean;
}) {
  const locale = (params.locale ?? "zh-CN").trim() || "zh-CN";
  const msg = params.message.trim();
  if (!msg) throw Errors.badRequest("message 为空");

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

  /* ── 记忆召回 + 工具发现阶段（架构-08§7 + 架构-11§4.1）── */
  const [memoryContext, taskContext, toolDiscovery] = await Promise.all([
    spaceId
      ? recallRelevantMemory({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, subjectId: params.subject.subjectId, message: userContent })
      : Promise.resolve(""),
    spaceId
      ? recallRecentTasks({ pool: params.pool, tenantId: params.subject.tenantId, spaceId })
      : Promise.resolve(""),
    spaceId
      ? discoverEnabledTools({ pool: params.pool, tenantId: params.subject.tenantId, spaceId, locale })
      : Promise.resolve({ catalog: "", tools: [] as EnabledTool[] }),
  ]);

  const modelMessages: { role: string; content: string }[] = [
    { role: "system", content: buildSystemPrompt(locale, memoryContext, taskContext, toolDiscovery.catalog) },
    ...clippedPrev
      .filter((m: any) => m && typeof m === "object")
      .map((m: any) => ({ role: String(m.role ?? "user"), content: String(m.content ?? "") }))
      .filter((m: any) => m.content),
    { role: "user", content: userContent },
  ];

  let outputText = "";
  let modelError = false;
  let modelErrorDetail = "";
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
  } catch (err: any) {
    if (params.propagateModelErrors && err && typeof err === "object" && (err.httpStatus === 429 || err.errorCode === "RATE_LIMITED")) throw err;
    outputText = "";
    modelError = true;
    const errMsg = err?.messageI18n ?? err?.message;
    if (errMsg && typeof errMsg === "object") {
      modelErrorDetail = String(errMsg[locale] ?? errMsg["zh-CN"] ?? Object.values(errMsg)[0] ?? "");
    } else if (typeof errMsg === "string") {
      modelErrorDetail = errMsg;
    }
    if (!modelErrorDetail && err?.errorCode) {
      modelErrorDetail = String(err.errorCode);
    }
  }

  const { cleanText: parsedReplyText, toolCalls } = parseToolCallsFromOutput(outputText);

  /* ── 验证 tool_call：仅保留确实已启用的工具 ── */
  const enabledToolRefSet = new Set(toolDiscovery.tools.map((t) => t.toolRef));
  const enabledToolMap = new Map(toolDiscovery.tools.map((t) => [t.toolRef, t]));
  const validatedSuggestions: Array<{
    toolRef: string;
    inputDraft: Record<string, unknown>;
    riskLevel: "low" | "medium" | "high";
    approvalRequired: boolean;
  }> = [];
  for (const tc of toolCalls) {
    if (!enabledToolRefSet.has(tc.toolRef)) continue;
    const tool = enabledToolMap.get(tc.toolRef);
    validatedSuggestions.push({
      toolRef: tc.toolRef,
      inputDraft: tc.inputDraft,
      riskLevel: tool?.def.riskLevel ?? "low",
      approvalRequired: tool?.def.approvalRequired ?? false,
    });
  }

  if (!validatedSuggestions.length && spaceId) {
    const hasSearchIntent = /搜索|查找|search/i.test(userContent);
    if (hasSearchIntent) {
      const t = toolDiscovery.tools.find((x) => x.name === "knowledge.search");
      if (t?.toolRef) {
        validatedSuggestions.push({
          toolRef: t.toolRef,
          inputDraft: { query: extractKnowledgeSearchQuery(userContent), limit: 5 },
          riskLevel: t.def.riskLevel ?? "low",
          approvalRequired: t.def.approvalRequired ?? false,
        });
      }
    }
  }

  const modelFallback = modelError
    ? (locale === "en-US"
        ? `I'm sorry, I couldn't process your request right now.${modelErrorDetail ? ` Reason: ${modelErrorDetail}` : " Please make sure a model binding is configured correctly in Settings > Model Onboarding."}`
        : `抱歉，当前无法处理您的请求。${modelErrorDetail ? `原因：${modelErrorDetail}` : "请确认已在【设置 > 模型接入】中正确配置模型绑定。"}`)
    : "";
  const replyText = parsedReplyText.trim() || modelFallback;

  if (params.persistSession !== false && spaceId) {
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
    conversationId,
    replyText,
    ...(validatedSuggestions.length ? { toolSuggestions: validatedSuggestions } : {}),
  };
  return res;
}
