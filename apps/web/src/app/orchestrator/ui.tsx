"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText, isPlainObject, safeJsonString } from "@/lib/apiError";
import { type TurnResponse, type ExecuteResponse } from "@/lib/types";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

function pageNameFromUiDirective(d: unknown): string | null {
  if (!isPlainObject(d)) return null;
  if (d.openView !== "page") return null;
  const viewParams = d.viewParams;
  if (!isPlainObject(viewParams)) return null;
  const name = viewParams.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return name.trim();
}

export default function OrchestratorPlaygroundClient(props: { locale: string }) {
  const [message, setMessage] = useState<string>("");
  const [conversationId, setConversationId] = useState<string>("");
  const [turn, setTurn] = useState<TurnResponse | null>(null);
  const [turnError, setTurnError] = useState<string>("");
  const [busyTurn, setBusyTurn] = useState<boolean>(false);

  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string>("");
  const [inputJson, setInputJson] = useState<string>("");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");

  const [exec, setExec] = useState<ExecuteResponse | null>(null);
  const [execError, setExecError] = useState<string>("");
  const [busyExec, setBusyExec] = useState<boolean>(false);

  const suggestions = useMemo(() => (Array.isArray(turn?.toolSuggestions) ? turn!.toolSuggestions! : []), [turn]);

  const replyText = useMemo(() => {
    const rt = turn?.replyText;
    if (!rt) return "";
    if (typeof rt === "string") return rt;
    return text(rt, props.locale);
  }, [props.locale, turn?.replyText]);

  async function sendTurn() {
    setTurnError("");
    setExec(null);
    setExecError("");
    setActiveIdx(null);
    setBusyTurn(true);
    try {
      const res = await apiFetch(`/orchestrator/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ message, ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}) }),
      });
      const json: unknown = await res.json().catch(() => null);
      const turnData = (json as TurnResponse) ?? null;
      setTurn(turnData);
      if (turnData?.conversationId) setConversationId(turnData.conversationId);
      if (!res.ok) setTurnError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusyTurn(false);
    }
  }

  function openSuggestion(idx: number) {
    const s = suggestions[idx];
    setActiveIdx(idx);
    setActiveSuggestionId(s?.suggestionId ?? "");
    setInputJson(safeJsonString(s?.inputDraft));
    setIdempotencyKey(s?.idempotencyKey ?? "");
    setExec(null);
    setExecError("");
  }

  async function executeSuggestion() {
    const idx = activeIdx;
    if (idx === null) return;
    const s = suggestions[idx];
    const toolRef = s?.toolRef ?? "";
    setExecError("");
    setBusyExec(true);
    try {
      let input: unknown;
      try {
        input = JSON.parse(inputJson);
      } catch {
        setExecError(t(props.locale, "orchestrator.playground.invalidJson"));
        return;
      }
      const turnId = turn?.turnId ?? "";
      const suggestionId = (activeSuggestionId || s?.suggestionId || "").trim();
      const payload:
        | { toolRef: string; input: unknown; idempotencyKey?: string }
        | { turnId: string; suggestionId: string; input: unknown; idempotencyKey?: string } =
        turnId && suggestionId ? { turnId, suggestionId, input } : { toolRef, input };
      if (idempotencyKey.trim()) {
        const k = idempotencyKey.trim();
        if ("toolRef" in payload) payload.idempotencyKey = k;
        else payload.idempotencyKey = k;
      }
      const res = await apiFetch(`/orchestrator/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(payload),
      });
      const json: unknown = await res.json().catch(() => null);
      setExec((json as ExecuteResponse) ?? null);
      if (!res.ok) setExecError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusyExec(false);
    }
  }

  const runHref = exec?.runId ? `/runs/${encodeURIComponent(exec.runId)}?lang=${encodeURIComponent(props.locale)}` : "";
  const approvalHref = exec?.approvalId ? `/gov/approvals/${encodeURIComponent(exec.approvalId)}?lang=${encodeURIComponent(props.locale)}` : "";
  const directivePageName = pageNameFromUiDirective(turn?.uiDirective);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "orchestrator.playground.title")}
        actions={null}
      />

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "orchestrator.playground.messageTitle")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t(props.locale, "orchestrator.playground.messagePlaceholder")}
              style={{ width: 520, maxWidth: "100%" }}
            />
            <input
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
              placeholder="conversationId"
              style={{ width: 300, maxWidth: "100%" }}
            />
            <button onClick={sendTurn} disabled={busyTurn || !message.trim()}>
              {busyTurn ? t(props.locale, "orchestrator.playground.sending") : t(props.locale, "orchestrator.playground.send")}
            </button>
          </div>
        </Card>
      </div>

      {turnError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 12 }}>{turnError}</pre> : null}

      {replyText ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.replyTitle")}>
            {turn?.turnId ? (
              <div style={{ marginBottom: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {t(props.locale, "orchestrator.playground.turnId")}: {turn.turnId}
              </div>
            ) : null}
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{replyText}</pre>
          </Card>
        </div>
      ) : null}

      {turn?.uiDirective ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.uiDirectiveTitle")}>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{safeJsonString(turn.uiDirective)}</pre>
            {directivePageName ? (
              <div style={{ marginTop: 8 }}>
                <Link href={`/p/${encodeURIComponent(directivePageName)}?lang=${encodeURIComponent(props.locale)}`}>
                  {t(props.locale, "orchestrator.playground.openPage")}
                </Link>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "orchestrator.playground.suggestionsTitle")}</span>
              <Badge>{suggestions.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "orchestrator.playground.table.suggestionId")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.table.toolRef")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.riskLevel")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.approvalRequired")}</th>
              <th align="left">{t(props.locale, "orchestrator.playground.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s, idx) => {
              const toolRef = s.toolRef ?? "";
              const isActive = activeIdx === idx;
              return (
                <tr key={`${toolRef}:${idx}`}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{s.suggestionId ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{toolRef || "-"}</td>
                  <td>{s.riskLevel ?? "-"}</td>
                  <td>{String(Boolean(s.approvalRequired))}</td>
                  <td>
                    {toolRef ? (
                      <button onClick={() => (isActive ? setActiveIdx(null) : openSuggestion(idx))}>
                        {isActive ? t(props.locale, "orchestrator.playground.close") : t(props.locale, "orchestrator.playground.editAndExecute")}
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      {activeIdx !== null ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.executeTitle")}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{t(props.locale, "orchestrator.playground.idempotencyKey")}</span>
                <input value={idempotencyKey} onChange={(e) => setIdempotencyKey(e.target.value)} style={{ width: 360, maxWidth: "100%" }} />
              </label>
              <button onClick={executeSuggestion} disabled={busyExec}>
                {busyExec ? t(props.locale, "orchestrator.playground.executing") : t(props.locale, "orchestrator.playground.execute")}
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 6 }}>{t(props.locale, "orchestrator.playground.inputJson")}</div>
              <textarea value={inputJson} onChange={(e) => setInputJson(e.target.value)} style={{ width: "100%", minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
            </div>
            {execError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 12 }}>{execError}</pre> : null}
          </Card>
        </div>
      ) : null}

      {exec ? (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "orchestrator.playground.resultTitle")}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "orchestrator.playground.status")}</span>
              <Badge>{exec.receipt?.status ?? "-"}</Badge>
              {exec.runId ? (
                <Link href={runHref}>
                  {t(props.locale, "orchestrator.playground.openRun")}
                </Link>
              ) : null}
              {exec.approvalId ? (
                <Link href={approvalHref}>
                  {t(props.locale, "orchestrator.playground.openApproval")}
                </Link>
              ) : null}
            </div>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{safeJsonString(exec)}</pre>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
