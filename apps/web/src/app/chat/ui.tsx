"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

type ToolSuggestion = {
  suggestionId?: string;
  toolRef?: string;
  inputDraft?: unknown;
  scope?: string;
  resourceType?: string;
  action?: string;
  riskLevel?: string;
  approvalRequired?: boolean;
  idempotencyKey?: string;
};

type TurnResponse = ApiError & {
  turnId?: string;
  conversationId?: string;
  replyText?: Record<string, string> | string;
  uiDirective?: unknown;
  toolSuggestions?: ToolSuggestion[];
};

type ExecuteResponse = ApiError & {
  jobId?: string;
  runId?: string;
  stepId?: string;
  approvalId?: string;
  idempotencyKey?: string;
  receipt?: { status?: string; correlation?: Record<string, unknown> };
};

type FlowMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type FlowError = {
  id: string;
  role: "assistant";
  errorCode: string;
  message: string;
  traceId: string;
};

type FlowDirective = {
  id: string;
  role: "assistant";
  kind: "uiDirective";
  directive: unknown;
  target: UiDirectiveTarget | null;
};

type FlowToolSuggestion = {
  id: string;
  role: "assistant";
  kind: "toolSuggestion";
  turnId: string | null;
  suggestion: ToolSuggestion;
};

type UiDirectiveTarget = { kind: "page"; name: string } | { kind: "workbench"; key: string };

type FlowExecuteReceipt = {
  id: string;
  role: "assistant";
  kind: "executeReceipt";
  receiptStatus: string;
  jobId: string;
  runId: string;
  stepId: string;
  approvalId: string;
  toolRef: string;
  turnId: string;
  suggestionId: string;
  idempotencyKey: string;
};

type ChatFlowItem =
  | ({ kind: "message" } & FlowMessage)
  | ({ kind: "error" } & FlowError)
  | FlowDirective
  | FlowToolSuggestion
  | FlowExecuteReceipt;

function safeJsonString(v: unknown) {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return "null";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function targetFromUiDirective(d: unknown): UiDirectiveTarget | null {
  if (!isPlainObject(d)) return null;
  const openView = d.openView;
  const viewParams = d.viewParams;
  if (!isPlainObject(viewParams)) return null;
  if (openView === "page") {
    const name = viewParams.name;
    if (typeof name !== "string" || !name.trim()) return null;
    return { kind: "page", name: name.trim() };
  }
  if (openView === "workbench") {
    const rawKey = viewParams.key ?? viewParams.workbenchKey;
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) return null;
    return { kind: "workbench", key };
  }
  return null;
}

function errorMessageText(locale: string, v: unknown) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (isPlainObject(v)) return text(v as Record<string, string>, locale);
  return String(v);
}

function nextId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function ChatClient(props: { locale: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<string>("");
  const [flow, setFlow] = useState<ChatFlowItem[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [conversationId, setConversationId] = useState<string>("");
  const [busyConv, setBusyConv] = useState<boolean>(false);

  const [activeSuggestion, setActiveSuggestion] = useState<FlowToolSuggestion | null>(null);
  const [inputJson, setInputJson] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [busyExec, setBusyExec] = useState<boolean>(false);
  const [execErrorText, setExecErrorText] = useState<string>("");
  const [execApiError, setExecApiError] = useState<ApiError | null>(null);

  const [directiveNav, setDirectiveNav] = useState<
    Record<string, { status: "checking" } | { status: "allowed" } | { status: "blocked"; hint: string }>
  >({});
  const directiveValidationStartedRef = useRef<Set<string>>(new Set());

  const canSend = useMemo(() => Boolean(draft.trim()) && !busy && !busyConv, [busy, busyConv, draft]);

  const openSuggestion = useCallback((it: FlowToolSuggestion) => {
    setActiveSuggestion(it);
    setInputJson(safeJsonString(it.suggestion.inputDraft));
    setIdempotencyKey(it.suggestion.idempotencyKey ?? "");
    setExecErrorText("");
    setExecApiError(null);
  }, []);

  const closeSuggestion = useCallback(() => {
    setActiveSuggestion(null);
    setExecErrorText("");
    setExecApiError(null);
  }, []);

  const startNewConversation = useCallback(() => {
    if (busy || busyConv) return;
    closeSuggestion();
    setConversationId("");
    setFlow([]);
  }, [busy, busyConv, closeSuggestion]);

  const clearConversation = useCallback(async () => {
    if (busy || busyConv) return;
    const cid = conversationId.trim();
    if (!cid) return;
    setBusyConv(true);
    try {
      const res = await fetch(`${API_BASE}/orchestrator/conversations/clear`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ conversationId: cid }),
      });
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => null);
        const e = isPlainObject(json) ? (json as ApiError) : {};
        const errorCode = (e.errorCode ?? String(res.status)).trim() || String(res.status);
        const messageText = errorMessageText(props.locale, e.message);
        const traceId = typeof e.traceId === "string" ? e.traceId : "";
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode, message: messageText, traceId }]);
        return;
      }
      closeSuggestion();
      setConversationId("");
      setFlow([]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "NETWORK_ERROR", message: msg, traceId: "" }]);
    } finally {
      setBusyConv(false);
    }
  }, [busy, busyConv, closeSuggestion, conversationId, props.locale]);

  const executeSuggestion = useCallback(async () => {
    const it = activeSuggestion;
    if (!it) return;
    setExecErrorText("");
    setExecApiError(null);
    setBusyExec(true);
    try {
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        setExecErrorText(t(props.locale, "chat.toolSuggestions.invalidJson"));
        return;
      }
      const turnId = it.turnId ?? "";
      const suggestionId = (it.suggestion.suggestionId ?? "").trim();
      const toolRef = (it.suggestion.toolRef ?? "").trim();
      const payload:
        | { toolRef: string; input: unknown; idempotencyKey?: string }
        | { turnId: string; suggestionId: string; input: unknown; idempotencyKey?: string } =
        turnId && suggestionId ? { turnId, suggestionId, input } : { toolRef, input };
      if (idempotencyKey.trim()) payload.idempotencyKey = idempotencyKey.trim();

      const res = await fetch(`${API_BASE}/orchestrator/execute`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json: unknown = await res.json().catch(() => null);
      const body = (json as ExecuteResponse) ?? null;
      if (res.ok) {
        const receiptStatus = String(body?.receipt?.status ?? "").trim() || "-";
        setFlow((prev) => [
          ...prev,
          {
            kind: "executeReceipt",
            id: nextId("x"),
            role: "assistant",
            receiptStatus,
            jobId: String(body?.jobId ?? ""),
            runId: String(body?.runId ?? ""),
            stepId: String(body?.stepId ?? ""),
            approvalId: String(body?.approvalId ?? ""),
            toolRef,
            turnId,
            suggestionId,
            idempotencyKey: String(body?.idempotencyKey ?? payload.idempotencyKey ?? ""),
          },
        ]);
      } else {
        const e = isPlainObject(body) ? (body as ApiError) : {};
        setExecApiError(e);
        const errorCode = (e.errorCode ?? String(res.status)).trim() || String(res.status);
        const messageText = errorMessageText(props.locale, e.message);
        const traceId = typeof e.traceId === "string" ? e.traceId : "";
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode, message: messageText, traceId }]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecErrorText(msg);
      setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "NETWORK_ERROR", message: msg, traceId: "" }]);
    } finally {
      setBusyExec(false);
    }
  }, [activeSuggestion, idempotencyKey, inputJson, props.locale]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy || busyConv) return;
    setDraft("");
    setBusy(true);
    closeSuggestion();
    setFlow((prev) => [...prev, { kind: "message", id: nextId("m"), role: "user", text: message }]);
    try {
      const res = await fetch(`${API_BASE}/orchestrator/turn`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ message, conversationId: conversationId.trim() || undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      const body = (json as TurnResponse) ?? null;
      if (res.ok) {
        if (typeof body?.conversationId === "string" && body.conversationId.trim()) setConversationId(body.conversationId.trim());
        const rawReply = body?.replyText;
        const reply =
          typeof rawReply === "string"
            ? rawReply
            : rawReply && typeof rawReply === "object"
              ? text(rawReply as Record<string, string>, props.locale)
              : t(props.locale, "chat.reply.empty");
        const items: ChatFlowItem[] = [{ kind: "message", id: nextId("m"), role: "assistant", text: reply }];
        if (body?.uiDirective != null) {
          const d = body.uiDirective;
          items.push({ kind: "uiDirective", id: nextId("d"), role: "assistant", directive: d, target: targetFromUiDirective(d) });
        }
        const turnId = typeof body?.turnId === "string" ? body.turnId : "";
        const suggestions = Array.isArray(body?.toolSuggestions) ? body!.toolSuggestions! : [];
        for (const s of suggestions) {
          items.push({ kind: "toolSuggestion", id: nextId("s"), role: "assistant", turnId: turnId || null, suggestion: s });
        }
        setFlow((prev) => [...prev, ...items]);
      } else {
        const e = isPlainObject(body) ? (body as ApiError) : {};
        const errorCode = (e.errorCode ?? String(res.status)).trim() || String(res.status);
        const messageText = errorMessageText(props.locale, e.message);
        const traceId = typeof e.traceId === "string" ? e.traceId : "";
        setFlow((prev) => [
          ...prev,
          { kind: "error", id: nextId("e"), role: "assistant", errorCode, message: messageText, traceId },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "NETWORK_ERROR", message: msg, traceId: "" }]);
    } finally {
      setBusy(false);
    }
  }, [busy, busyConv, closeSuggestion, conversationId, draft, props.locale]);

  const validateDirective = useCallback(
    async (it: FlowDirective) => {
      const target = it.target;
      if (!target) return;
      try {
        if (target.kind === "page") {
          const res = await fetch(`${API_BASE}/ui/pages/${encodeURIComponent(target.name)}`, {
            method: "GET",
            headers: apiHeaders(props.locale),
            cache: "no-store",
          });
          if (res.status === 401 || res.status === 403) {
            setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "blocked", hint: t(props.locale, "chat.uiDirective.forbidden") } }));
            return;
          }
          const json: unknown = await res.json().catch(() => null);
          const released = res.ok && isPlainObject(json) ? (json as Record<string, unknown>)["released"] : null;
          if (released != null) {
            setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "allowed" } }));
            return;
          }
          setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "blocked", hint: t(props.locale, "chat.uiDirective.pageNotReleased") } }));
          return;
        }

        if (target.kind === "workbench") {
          const res = await fetch(`${API_BASE}/workbenches/${encodeURIComponent(target.key)}/effective`, {
            method: "GET",
            headers: apiHeaders(props.locale),
            cache: "no-store",
          });
          if (res.status === 401 || res.status === 403) {
            setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "blocked", hint: t(props.locale, "chat.uiDirective.forbidden") } }));
            return;
          }
          if (res.status === 200) {
            setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "allowed" } }));
            return;
          }
          setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "blocked", hint: t(props.locale, "chat.uiDirective.workbenchUnavailable") } }));
          return;
        }
      } catch {
        setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "blocked", hint: t(props.locale, "chat.uiDirective.validationFailed") } }));
      }
    },
    [props.locale],
  );

  useEffect(() => {
    for (const it of flow) {
      if (it.kind !== "uiDirective") continue;
      if (!it.target) continue;
      if (directiveValidationStartedRef.current.has(it.id)) continue;
      directiveValidationStartedRef.current.add(it.id);
      setDirectiveNav((prev) => ({ ...prev, [it.id]: { status: "checking" } }));
      void validateDirective(it);
    }
  }, [flow, validateDirective]);

  const openDirective = useCallback(
    async (it: FlowDirective) => {
      const target = it.target;
      if (!target) return;
      const st = directiveNav[it.id];
      if (!st || st.status !== "allowed") return;
      if (target.kind === "page") {
        router.push(`/p/${encodeURIComponent(target.name)}?lang=${encodeURIComponent(props.locale)}`);
        return;
      }
      if (target.kind === "workbench") {
        router.push(`/w/${encodeURIComponent(target.key)}?lang=${encodeURIComponent(props.locale)}`);
        return;
      }
    },
    [directiveNav, props.locale, router],
  );


  return (
    <div style={{ display: "grid", gap: 16 }}>
      <PageHeader title={t(props.locale, "chat.title")} description={t(props.locale, "chat.desc")} />

      <Card title={t(props.locale, "chat.session.title")}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.session.conversationId")}</span>
            <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{conversationId || "-"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={startNewConversation} disabled={busy || busyConv}>
              {t(props.locale, "chat.session.new")}
            </button>
            <button onClick={clearConversation} disabled={!conversationId.trim() || busy || busyConv}>
              {busyConv ? t(props.locale, "chat.session.clearing") : t(props.locale, "chat.session.clear")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "chat.messages.title")}>
        {flow.length ? (
          <div style={{ display: "grid", gap: 10 }}>
            {flow.map((it) => {
              const isAssistant = it.role === "assistant";
              const borderColor = it.kind === "error" ? "color-mix(in srgb, crimson 55%, var(--sl-border))" : "var(--sl-border)";
              const meta = it.kind === "message" ? it.role : it.kind;
              return (
                <div
                  key={it.id}
                  style={{
                    display: "grid",
                    gap: 6,
                    padding: 10,
                    border: `1px solid ${borderColor}`,
                    borderRadius: 12,
                    background: isAssistant ? "color-mix(in srgb, var(--sl-surface) 85%, transparent)" : "color-mix(in srgb, var(--sl-surface) 65%, transparent)",
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--sl-muted)" }}>{meta}</div>
                  {it.kind === "message" ? <div style={{ whiteSpace: "pre-wrap" }}>{it.text}</div> : null}
                  {it.kind === "error" ? (
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontWeight: 600 }}>{t(props.locale, "chat.error.title")}</div>
                      <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", whiteSpace: "pre-wrap" }}>
                        {safeJsonString({ errorCode: it.errorCode, message: it.message, traceId: it.traceId })}
                      </div>
                    </div>
                  ) : null}
                  {it.kind === "uiDirective" ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontWeight: 600 }}>{t(props.locale, "chat.uiDirective.title")}</div>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{safeJsonString(it.directive)}</pre>
                      {it.target ? (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          {directiveNav[it.id]?.status === "allowed" ? (
                            <button onClick={() => void openDirective(it)}>
                              {it.target.kind === "page" ? t(props.locale, "chat.uiDirective.openPage") : t(props.locale, "chat.uiDirective.openWorkbench")}
                            </button>
                          ) : directiveNav[it.id]?.status === "blocked" ? (
                            <>
                              <span>
                                {it.target.kind === "page" ? t(props.locale, "chat.uiDirective.openPage") : t(props.locale, "chat.uiDirective.openWorkbench")}
                              </span>
                              <span style={{ color: "var(--sl-muted)" }}>{(directiveNav[it.id] as { status: "blocked"; hint: string }).hint}</span>
                            </>
                          ) : (
                            <>
                              <span>
                                {it.target.kind === "page" ? t(props.locale, "chat.uiDirective.openPage") : t(props.locale, "chat.uiDirective.openWorkbench")}
                              </span>
                              <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.uiDirective.checking")}</span>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {it.kind === "toolSuggestion" ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <div style={{ fontWeight: 600 }}>{t(props.locale, "chat.toolSuggestions.title")}</div>
                        <Badge>{it.suggestion.riskLevel ?? "-"}</Badge>
                        {typeof it.suggestion.approvalRequired === "boolean" ? (
                          <Badge>
                            {t(props.locale, "chat.toolSuggestions.approvalRequired")}: {String(it.suggestion.approvalRequired)}
                          </Badge>
                        ) : null}
                      </div>
                      <div style={{ display: "grid", gap: 4 }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.toolSuggestions.toolRef")}</span>
                          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{it.suggestion.toolRef ?? "-"}</span>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.toolSuggestions.suggestionId")}</span>
                          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{it.suggestion.suggestionId ?? "-"}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <button onClick={() => openSuggestion(it)} disabled={!String(it.suggestion.toolRef ?? "").trim()}>
                          {t(props.locale, "chat.toolSuggestions.openExecute")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {it.kind === "executeReceipt" ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <div style={{ fontWeight: 600 }}>{t(props.locale, "chat.toolSuggestions.receiptTitle")}</div>
                        <Badge>{it.receiptStatus || "-"}</Badge>
                        {it.runId ? (
                          <Link href={`/runs/${encodeURIComponent(it.runId)}?lang=${encodeURIComponent(props.locale)}`}>
                            {t(props.locale, "chat.toolSuggestions.openRun")}
                          </Link>
                        ) : null}
                        {it.approvalId ? (
                          <Link href={`/gov/approvals/${encodeURIComponent(it.approvalId)}?lang=${encodeURIComponent(props.locale)}`}>
                            {t(props.locale, "chat.toolSuggestions.openApproval")}
                          </Link>
                        ) : null}
                      </div>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {safeJsonString({
                          receiptStatus: it.receiptStatus,
                          jobId: it.jobId || undefined,
                          runId: it.runId || undefined,
                          stepId: it.stepId || undefined,
                          approvalId: it.approvalId || undefined,
                          idempotencyKey: it.idempotencyKey || undefined,
                          toolRef: it.toolRef || undefined,
                          turnId: it.turnId || undefined,
                          suggestionId: it.suggestionId || undefined,
                        })}
                      </pre>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.messages.empty")}</div>
        )}
      </Card>

      {activeSuggestion ? (
        <Card title={t(props.locale, "chat.toolSuggestions.executePanelTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 900 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ color: "var(--sl-muted)" }}>{t(props.locale, "chat.toolSuggestions.toolRef")}</span>
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {activeSuggestion.suggestion.toolRef ?? "-"}
              </span>
              <Badge>{activeSuggestion.suggestion.riskLevel ?? "-"}</Badge>
              {typeof activeSuggestion.suggestion.approvalRequired === "boolean" ? (
                <Badge>
                  {t(props.locale, "chat.toolSuggestions.approvalRequired")}: {String(activeSuggestion.suggestion.approvalRequired)}
                </Badge>
              ) : null}
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <span>{t(props.locale, "chat.toolSuggestions.idempotencyKey")}</span>
              <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} style={{ width: "100%" }} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span>{t(props.locale, "chat.toolSuggestions.inputJson")}</span>
              <textarea
                value={inputJson}
                onChange={(e) => setInputJson(e.target.value)}
                style={{ width: "100%", minHeight: 240, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={executeSuggestion} disabled={busyExec}>
                {busyExec ? t(props.locale, "chat.toolSuggestions.executing") : t(props.locale, "chat.toolSuggestions.confirmExecute")}
              </button>
              <button onClick={closeSuggestion} disabled={busyExec}>
                {t(props.locale, "chat.toolSuggestions.closeExecute")}
              </button>
            </div>
            {execErrorText ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{execErrorText}</pre> : null}
            {execApiError ? (
              <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>
                {safeJsonString({
                  errorCode: execApiError.errorCode ?? "ERROR",
                  message: errorMessageText(props.locale, execApiError.message),
                  traceId: execApiError.traceId ?? "",
                })}
              </pre>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card title={t(props.locale, "chat.composer.title")}>
        <div style={{ display: "grid", gap: 8, maxWidth: 900 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t(props.locale, "chat.composer.placeholder")}
            style={{ width: "100%", minHeight: 64, resize: "vertical" }}
            disabled={busy || busyConv}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              e.preventDefault();
              void send();
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={send} disabled={!canSend}>
              {busy ? t(props.locale, "chat.composer.sending") : t(props.locale, "chat.composer.send")}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
