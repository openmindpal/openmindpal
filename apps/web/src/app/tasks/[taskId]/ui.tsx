"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RunLite = { runId: string; status: string; jobType?: string | null; toolRef?: string | null };
type TaskDetailResp = { task?: unknown; runs?: RunLite[] } & ApiError;
type MessagesResp = { messages?: unknown[] } & ApiError;
type CollabRunLite = { collabRunId: string; status: string; roles?: unknown; limits?: unknown; primaryRunId?: string | null; createdAt?: string; updatedAt?: string };
type CollabRunsResp = { items?: CollabRunLite[]; nextBefore?: string | null } & ApiError;

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function TaskDetailClient(props: {
  locale: string;
  taskId: string;
  initialTask: unknown;
  initialTaskStatus: number;
  initialMessages: unknown;
  initialMessagesStatus: number;
  initialCollabRuns: unknown;
  initialCollabRunsStatus: number;
}) {
  const [taskData, setTaskData] = useState<TaskDetailResp | null>((props.initialTask as TaskDetailResp) ?? null);
  const [taskStatus, setTaskStatus] = useState<number>(props.initialTaskStatus);
  const [msgData, setMsgData] = useState<MessagesResp | null>((props.initialMessages as MessagesResp) ?? null);
  const [msgStatus, setMsgStatus] = useState<number>(props.initialMessagesStatus);
  const [collabData, setCollabData] = useState<CollabRunsResp | null>((props.initialCollabRuns as CollabRunsResp) ?? null);
  const [collabStatus, setCollabStatus] = useState<number>(props.initialCollabRunsStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [handoffText, setHandoffText] = useState<string>("");
  const [collabMessage, setCollabMessage] = useState<string>("");

  const task = taskData?.task ?? null;
  const runs = useMemo(() => (Array.isArray(taskData?.runs) ? (taskData!.runs as RunLite[]) : []), [taskData]);
  const messages = useMemo(() => (Array.isArray(msgData?.messages) ? msgData!.messages! : []), [msgData]);
  const collabRuns = useMemo(() => (Array.isArray(collabData?.items) ? (collabData!.items as CollabRunLite[]) : []), [collabData]);

  const initialError = useMemo(() => {
    if (taskStatus >= 400) return errText(props.locale, taskData);
    if (msgStatus >= 400) return errText(props.locale, msgData);
    if (collabStatus >= 400) return errText(props.locale, collabData);
    return "";
  }, [collabData, collabStatus, msgData, msgStatus, props.locale, taskData, taskStatus]);

  async function refresh() {
    setError("");
    const tRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}`, { locale: props.locale, cache: "no-store" });
    setTaskStatus(tRes.status);
    const tJson: unknown = await tRes.json().catch(() => null);
    setTaskData((tJson as TaskDetailResp) ?? null);
    const mRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/messages?limit=50`, { locale: props.locale, cache: "no-store" });
    setMsgStatus(mRes.status);
    const mJson: unknown = await mRes.json().catch(() => null);
    setMsgData((mJson as MessagesResp) ?? null);
    const cRes = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs?limit=50`, { locale: props.locale, cache: "no-store" });
    setCollabStatus(cRes.status);
    const cJson: unknown = await cRes.json().catch(() => null);
    setCollabData((cJson as CollabRunsResp) ?? null);
    if (!tRes.ok) setError(errText(props.locale, (tJson as ApiError) ?? { errorCode: String(tRes.status) }));
    else if (!mRes.ok) setError(errText(props.locale, (mJson as ApiError) ?? { errorCode: String(mRes.status) }));
    else if (!cRes.ok) setError(errText(props.locale, (cJson as ApiError) ?? { errorCode: String(cRes.status) }));
  }

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(runId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function continueAgentRun(runId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/agent-runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function sendHandoff() {
    if (!handoffText.trim()) return;
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          from: { role: "human" },
          intent: "handoff",
          outputs: { summary: handoffText.trim().slice(0, 2000) },
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setHandoffText("");
    });
  }

  async function createCollabRun() {
    if (!collabMessage.trim()) return;
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(props.taskId)}/collab-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ message: collabMessage.trim().slice(0, 4000) }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCollabMessage("");
    });
  }

  const messageSummaries = useMemo(() => {
    return messages.map((m: any, i: number) => {
      const from = m?.from && typeof m.from === "object" ? m.from : null;
      const outputs = m?.outputs ?? null;
      const inputs = m?.inputs ?? null;
      const evOut = outputs && typeof outputs === "object" && Array.isArray((outputs as any).evidenceRefs) ? ((outputs as any).evidenceRefs as any[]) : [];
      const evIn = inputs && typeof inputs === "object" && Array.isArray((inputs as any).evidenceRefs) ? ((inputs as any).evidenceRefs as any[]) : [];
      const evidenceRefs = [...evIn, ...evOut].slice(0, 20);
      return {
        key: String(m?.messageId ?? m?.message_id ?? i),
        createdAt: String(m?.createdAt ?? m?.created_at ?? ""),
        role: String(from?.role ?? m?.from_role ?? ""),
        intent: String(m?.intent ?? ""),
        correlation: m?.correlation ?? null,
        evidenceRefs,
        outputs,
      };
    });
  }, [messages]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "tasks.detailTitle")}
        description={<span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>taskId={props.taskId}</span>}
        actions={
          <>
            <Badge>{taskStatus}</Badge>
            <Badge>{msgStatus}</Badge>
            <Badge>{collabStatus}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "tasks.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(task, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "tasks.runsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">runId</th>
              <th align="left">status</th>
              <th align="left">jobType</th>
              <th align="left">toolRef</th>
              <th align="left">{t(props.locale, "tasks.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  <Link href={`/runs/${encodeURIComponent(r.runId)}?lang=${encodeURIComponent(props.locale)}`}>{r.runId}</Link>
                </td>
                <td>
                  <Badge>{r.status}</Badge>
                </td>
                <td>{r.jobType ?? "-"}</td>
                <td>{r.toolRef ?? "-"}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => cancelRun(r.runId)} disabled={busy || !r.runId}>
                      {t(props.locale, "action.cancel")}
                    </button>
                    <button onClick={() => continueAgentRun(r.runId)} disabled={busy || r.jobType !== "agent.run" || r.status !== "needs_approval"}>
                      {t(props.locale, "action.continue")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "tasks.collabTitle")}>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 6, maxWidth: 720 }}>
              <div>{t(props.locale, "tasks.collabCreateTitle")}</div>
              <textarea
                value={collabMessage}
                onChange={(e) => setCollabMessage(e.target.value)}
                rows={3}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
              />
              <button onClick={createCollabRun} disabled={busy || !collabMessage.trim()}>
                {t(props.locale, "tasks.collabCreateButton")}
              </button>
            </div>

            <Table header={<span>{t(props.locale, "tasks.collabRunsTitle")}</span>}>
              <thead>
                <tr>
                  <th align="left">collabRunId</th>
                  <th align="left">status</th>
                  <th align="left">roles</th>
                  <th align="left">primaryRunId</th>
                </tr>
              </thead>
              <tbody>
                {collabRuns.map((c) => {
                  const roles = Array.isArray(c.roles) ? (c.roles as any[]) : [];
                  const roleNames = roles.map((r) => String(r?.roleName ?? "")).filter(Boolean);
                  return (
                    <tr key={c.collabRunId}>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                        <Link href={`/tasks/${encodeURIComponent(props.taskId)}/collab-runs/${encodeURIComponent(c.collabRunId)}?lang=${encodeURIComponent(props.locale)}`}>
                          {c.collabRunId}
                        </Link>
                      </td>
                      <td>
                        <Badge>{c.status}</Badge>
                      </td>
                      <td>{roleNames.length ? roleNames.join(", ") : "-"}</td>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                        {c.primaryRunId ? <Link href={`/runs/${encodeURIComponent(c.primaryRunId)}?lang=${encodeURIComponent(props.locale)}`}>{c.primaryRunId}</Link> : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "tasks.messagesTitle")}>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 6, maxWidth: 720 }}>
              <div>handoff</div>
              <textarea
                value={handoffText}
                onChange={(e) => setHandoffText(e.target.value)}
                rows={4}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
              />
              <button onClick={sendHandoff} disabled={busy || !handoffText.trim()}>
                {t(props.locale, "submit")}
              </button>
            </div>
            <Table header={<span>timeline</span>}>
              <thead>
                <tr>
                  <th align="left">createdAt</th>
                  <th align="left">role</th>
                  <th align="left">intent</th>
                  <th align="left">correlation</th>
                  <th align="left">evidenceRefs</th>
                  <th align="left">outputs</th>
                </tr>
              </thead>
              <tbody>
                {messageSummaries.map((m) => (
                  <tr key={m.key}>
                    <td>{m.createdAt || "-"}</td>
                    <td>{m.role || "-"}</td>
                    <td>
                      <Badge>{m.intent || "-"}</Badge>
                    </td>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(m.correlation, null, 2)}</pre>
                    </td>
                    <td>
                      {m.evidenceRefs.length ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(m.evidenceRefs, null, 2)}</pre> : "-"}
                    </td>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(m.outputs, null, 2)}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
