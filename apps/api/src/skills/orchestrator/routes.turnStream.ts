import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { redactValue } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { parseToolCallsFromOutput } from "../../lib/llm";
import { openSse } from "../../lib/sse";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { insertAuditEvent } from "../../modules/audit/auditRepo";
import { generateUiFromNaturalLanguage, prefetchNl2UiContext } from "../nl2ui-generator/modules/generator";
import { discoverEnabledTools } from "./modules/orchestrator";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { sha256Hex } from "../../lib/digest";
import { getSessionContext, upsertSessionContext, type SessionMessage } from "../memory-manager/modules/sessionContextRepo";
import { listRecentTaskStates, searchMemory } from "../memory-manager/modules/repo";
import { getPromptInjectionModeFromEnv, scanPromptInjection, summarizePromptInjection } from "../safety-policy/modules/promptInjectionGuard";
import { invokeModelChatUpstreamStream } from "../model-gateway/modules/invokeChatUpstreamStream";

export const orchestratorTurnStreamRoutes: FastifyPluginAsync = async (app) => {
  async function handleTurnStream(req: any, reply: any, message: string, conversationId: string | null, locale: string, previousConfig?: any) {
    const subject = req.ctx.subject!;

    const sse = openSse({ req, reply });

    const heartbeatId = setInterval(() => {
      sse.sendEvent("ping", { ts: Date.now() });
    }, 10_000);

    try {
      sse.sendEvent("ping", { ts: Date.now() });
      sse.sendEvent("status", { phase: "started" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const piMode = getPromptInjectionModeFromEnv();
      const piTarget = "orchestrator:turn";
      const piScan = scanPromptInjection(message);
      const piSummary = summarizePromptInjection(piScan, piMode, piTarget, false);
      sse.sendEvent("safety", { promptInjection: piSummary });

      sse.sendEvent("status", { phase: "thinking" });
      const nl2uiPrefetchPromise = prefetchNl2UiContext(app.db, { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId }, message, undefined, !!previousConfig);
      const convId = (conversationId ?? "").trim() || crypto.randomUUID();

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

      const spaceId = subject.spaceId ?? "";
      const historyLimit = conversationWindowSize();
      const nowIso = new Date().toISOString();
      const redactedMsg = redactValue(message);
      const userContent = String(redactedMsg.value ?? "");

      const prev = spaceId ? await getSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, sessionId: convId }) : null;
      const prevMsgs = Array.isArray(prev?.context?.messages) ? prev!.context.messages : [];
      const clippedPrev = prevMsgs.slice(Math.max(0, prevMsgs.length - (historyLimit - 2)));

      async function recallRelevantMemory(): Promise<string> {
        const limitRaw = Number(process.env.ORCHESTRATOR_MEMORY_RECALL_LIMIT ?? "5");
        const limit = clampInt(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 5, 0, 20);
        if (!spaceId || limit <= 0) return "";
        try {
          const result = await searchMemory({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, query: userContent.slice(0, 200), limit });
          const evidence = result.evidence ?? [];
          if (!evidence.length) return "";
          const maxChars = 1200;
          let total = 0;
          const lines: string[] = [];
          for (const e of evidence) {
            const line = `- [${e.type ?? "memory"}] ${e.title ? e.title + ": " : ""}${e.snippet}`;
            if (total + line.length > maxChars) break;
            lines.push(line);
            total += line.length;
          }
          return lines.join("\n");
        } catch {
          return "";
        }
      }

      async function recallRecentTasks(): Promise<string> {
        if (!spaceId) return "";
        try {
          const tasks = await listRecentTaskStates({ pool: app.db, tenantId: subject.tenantId, spaceId, limit: 5 });
          if (!tasks.length) return "";
          const maxChars = 800;
          let total = 0;
          const lines: string[] = [];
          for (const t of tasks) {
            const planSummary = t.plan && typeof t.plan === "object" ? (Array.isArray((t.plan as any).steps) ? `${(t.plan as any).steps.length} steps` : "has plan") : "no plan";
            const line = `- [${t.phase}] run=${t.runId.slice(0, 8)}… ${planSummary}, updated=${t.updatedAt}`;
            if (total + line.length > maxChars) break;
            lines.push(line);
            total += line.length;
          }
          return lines.join("\n");
        } catch {
          return "";
        }
      }

      function buildSystemPrompt(memoryContext: string, taskContext: string, toolCatalog: string): string {
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
          parts.push("\nNo tools are currently enabled in this workspace. You can still help with information, analysis, and suggestions.");
        }
        if (memoryContext) parts.push("\n## Recalled Memory\n" + memoryContext + "\n\nUse the above recalled memory to provide contextually relevant responses.");
        if (taskContext) parts.push("\n## Recent Tasks\n" + taskContext + "\n\nUse the above task history to understand what the user has been working on recently.");
        return parts.join("\n");
      }

      const [memoryContext, taskContext, toolDiscovery] = await Promise.all([
        recallRelevantMemory(),
        recallRecentTasks(),
        spaceId ? discoverEnabledTools({ pool: app.db, tenantId: subject.tenantId, spaceId, locale }) : Promise.resolve({ catalog: "", tools: [] as any[] }),
      ]);

      const modelMessages: { role: string; content: string }[] = [
        { role: "system", content: buildSystemPrompt(memoryContext, taskContext, toolDiscovery.catalog) },
        ...clippedPrev.filter((m: any) => m && typeof m === "object").map((m: any) => ({ role: String(m.role ?? "user"), content: String(m.content ?? "") })).filter((m: any) => m.content),
        { role: "user", content: userContent },
      ];

      const modelDecision = await requirePermission({ req, resourceType: "model", action: "invoke" });

      function createToolCallFilter(onVisible: (t: string) => void) {
        const START = "```tool_call";
        const END = "```";
        let mode: "text" | "tool" = "text";
        let buf = "";
        const keepTail = START.length - 1;
        const keepEndTail = END.length - 1;
        return {
          feed(chunk: string) {
            buf += chunk;
            while (buf) {
              if (mode === "text") {
                const idx = buf.indexOf(START);
                if (idx === -1) {
                  if (buf.length > keepTail) {
                    const out = buf.slice(0, buf.length - keepTail);
                    buf = buf.slice(buf.length - keepTail);
                    if (out) onVisible(out);
                  }
                  return;
                }
                const out = buf.slice(0, idx);
                if (out) onVisible(out);
                buf = buf.slice(idx + START.length);
                mode = "tool";
                continue;
              }
              const idx2 = buf.indexOf(END);
              if (idx2 === -1) {
                if (buf.length > keepEndTail) buf = buf.slice(buf.length - keepEndTail);
                return;
              }
              buf = buf.slice(idx2 + END.length);
              mode = "text";
            }
          },
          flush() {
            if (mode === "text" && buf) onVisible(buf);
            buf = "";
          },
        };
      }

      let rawOutput = "";
      let visible = "";
      const filter = createToolCallFilter((t) => {
        if (!t) return;
        visible += t;
        sse.sendEvent("delta", { text: t });
      });

      let modelOut: any = null;
      try {
        modelOut = await invokeModelChatUpstreamStream({
          app,
          subject,
          body: { purpose: "orchestrator.turn", scene: "orchestrator.turn", messages: modelMessages, stream: true },
          traceId: req.ctx.traceId,
          requestId: req.ctx.requestId,
          locale,
          signal: sse.signal,
          onDelta: (t) => {
            rawOutput += t;
            filter.feed(t);
          },
        });
      } finally {
        filter.flush();
      }

      const parsed = parseToolCallsFromOutput(rawOutput);
      const cleanText = parsed.cleanText;
      if (cleanText.startsWith(visible) && cleanText.length > visible.length) {
        const rest = cleanText.slice(visible.length);
        if (rest) sse.sendEvent("delta", { text: rest });
        visible = cleanText;
      }

      const enabledToolRefSet = new Set((toolDiscovery.tools ?? []).map((t: any) => t.toolRef));
      const enabledToolMap = new Map((toolDiscovery.tools ?? []).map((t: any) => [t.toolRef, t]));
      // 拦截 nl2ui.generate 工具调用：自动触发生成，不发前端按钮
      const nl2uiToolCall = parsed.toolCalls.find((tc) => tc.toolRef === "nl2ui.generate" || tc.toolRef.startsWith("nl2ui.generate@"));

      const validatedSuggestions: Array<{ toolRef: string; inputDraft: Record<string, unknown>; riskLevel: "low" | "medium" | "high"; approvalRequired: boolean }> = [];
      for (const tc of parsed.toolCalls) {
        // 跳过 nl2ui.generate，不发给前端作为工具建议
        if (tc.toolRef === "nl2ui.generate" || tc.toolRef.startsWith("nl2ui.generate@")) continue;
        if (!enabledToolRefSet.has(tc.toolRef)) continue;
        const tool = enabledToolMap.get(tc.toolRef);
        validatedSuggestions.push({ toolRef: tc.toolRef, inputDraft: tc.inputDraft, riskLevel: tool?.def?.riskLevel ?? "low", approvalRequired: tool?.def?.approvalRequired ?? false });
      }

      const toolSuggestions = validatedSuggestions.map((s) => ({ ...s, suggestionId: crypto.randomUUID() }));
      if (toolSuggestions.length) sse.sendEvent("toolSuggestions", { suggestions: toolSuggestions });

      const replyText = cleanText.trim();
      if (spaceId) {
        function coerceRole(v: any): "user" | "assistant" | "system" {
          const r = String(v ?? "");
          if (r === "assistant" || r === "system" || r === "user") return r;
          return "user";
        }
        const assistantRedacted = redactValue(replyText);
        const assistantContent = String(assistantRedacted.value ?? "");
        const nextMsgs: SessionMessage[] = [
          ...clippedPrev.map((m: any) => ({ role: coerceRole(m.role), content: String(m.content ?? ""), at: typeof m.at === "string" ? m.at : undefined })).filter((m) => m.content),
          { role: "user", content: userContent, at: nowIso },
          { role: "assistant", content: assistantContent, at: nowIso },
        ];
        const trimmed = nextMsgs.slice(Math.max(0, nextMsgs.length - historyLimit));
        const expiresAt = new Date(Date.now() + conversationTtlMs()).toISOString();
        await upsertSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId, subjectId: subject.subjectId, sessionId: convId, context: { v: 1, messages: trimmed }, expiresAt });
      }

      try {
        if (modelOut && typeof modelOut === "object") {
          await insertAuditEvent(app.db, {
            subjectId: subject.subjectId,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            resourceType: "model",
            action: "invoke.stream",
            policyDecision: modelDecision,
            inputDigest: { purpose: "orchestrator.turn", scene: "orchestrator.turn", messageCount: modelMessages.length },
            outputDigest: { routingDecision: modelOut.routingDecision ?? null, usage: modelOut.usage ?? null, latencyMs: modelOut.latencyMs ?? null, outputTextLen: rawOutput.length, attempts: modelOut.attempts ?? null, safetySummary: modelOut.safetySummary ?? null },
            result: "success",
            traceId: req.ctx.traceId,
            requestId: req.ctx.requestId,
          });
        }
      } catch {
      }

      // 只有编排器模型调用了 nl2ui.generate 时才触发 NL2UI 生成
      if (nl2uiToolCall) {
        sse.sendEvent("nl2uiStatus", { phase: "started" });
        const keepaliveTimer = setInterval(() => {
          try {
            sse.sendEvent("keepalive", { ts: Date.now() });
          } catch {
          }
        }, 8_000);
        try {
          const nl2uiPrefetched = await nl2uiPrefetchPromise;
          const nl2uiUserInput = typeof nl2uiToolCall.inputDraft?.userInput === "string" ? nl2uiToolCall.inputDraft.userInput : message;
          const cfg = await generateUiFromNaturalLanguage(
            app.db,
            { userInput: nl2uiUserInput, context: { userId: subject.subjectId || "anonymous", tenantId: subject.tenantId, spaceId: subject.spaceId || undefined }, previousConfig },
            { app, authorization: (req.headers.authorization as string | undefined) ?? "", traceId: req.ctx.traceId },
            nl2uiPrefetched,
          );
          if (cfg) sse.sendEvent("nl2uiResult", { config: cfg });
        } catch (err: any) {
          if (err && typeof err === "object" && err.statusCode === 429) {
            const payload = err.payload && typeof err.payload === "object" ? err.payload : { errorCode: "RATE_LIMITED", message: { "zh-CN": "请求过于频繁", "en-US": "Too many requests" }, traceId: req.ctx.traceId };
            sse.sendEvent("nl2uiError", payload);
          } else if (err && typeof err === "object" && err.payload && typeof err.payload === "object") {
            sse.sendEvent("nl2uiError", err.payload);
          } else if (err && typeof err === "object" && ("errorCode" in err || "messageI18n" in err || "message" in err)) {
            sse.sendEvent("nl2uiError", { errorCode: String((err as any).errorCode ?? "NL2UI_ERROR"), message: (err as any).messageI18n ?? (err as any).message ?? { "zh-CN": "界面生成异常", "en-US": "UI generation error" }, traceId: req.ctx.traceId });
          } else {
            sse.sendEvent("nl2uiError", { errorCode: "NL2UI_ERROR", message: { "zh-CN": "界面生成异常", "en-US": "UI generation error" }, traceId: req.ctx.traceId });
          }
        } finally {
          clearInterval(keepaliveTimer);
          sse.sendEvent("nl2uiStatus", { phase: "done" });
        }
      }

      const messageDigest = { len: message.length, sha256_8: sha256Hex(message).slice(0, 8) };
      const turn = await createOrchestratorTurn({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId, message: "", toolSuggestions: null, messageDigest, toolSuggestionsDigest: null });

      sse.sendEvent("done", { turnId: turn.turnId, conversationId: convId });
    } catch (err: any) {
      const code = err?.errorCode ?? "INTERNAL_ERROR";
      const msg = err?.messageI18n ?? err?.message ?? "Unknown error";
      const retryAfterSec = Number(err?.retryAfterSec);
      sse.sendEvent("error", { errorCode: code, message: msg, traceId: req.ctx.traceId, ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {}) });
    } finally {
      clearInterval(heartbeatId);
      sse.close();
    }
  }

  app.get("/orchestrator/turn/stream", async (req, reply) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "turn.stream" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const qs = req.query as Record<string, string>;
    const message = String(qs.message ?? "").trim();
    if (!message) throw Errors.badRequest("缺少 message");
    const conversationId = String(qs.conversationId ?? "").trim() || null;
    const locale = String(qs.locale ?? req.ctx.locale ?? "zh-CN");

    await handleTurnStream(req, reply, message, conversationId, locale, undefined);
  });

  app.post("/orchestrator/turn/stream", async (req, reply) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "turn.stream" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const message = String(body.message ?? "").trim();
    if (!message) throw Errors.badRequest("缺少 message");
    const conversationId = String(body.conversationId ?? "").trim() || null;
    const locale = String(body.locale ?? req.ctx.locale ?? "zh-CN");
    const previousConfig = (body as any).previousConfig;

    await handleTurnStream(req, reply, message, conversationId, locale, previousConfig);
  });
};
