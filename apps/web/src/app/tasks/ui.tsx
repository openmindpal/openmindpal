"use client";

import Link from "next/link";
import { useMemo, useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type LongTaskItem = {
  task: { taskId: string; title: string | null; status: string; createdAt: string; updatedAt: string };
  run: { runId: string; status: string; jobType: string | null; toolRef: string | null; traceId: string | null; startedAt: string | null; finishedAt: string | null; updatedAt: string | null } | null;
  progress: { phase: string | null };
  controls: { canCancel: boolean; canContinue: boolean; needsApproval: boolean };
};

type LongTasksResp = { longTasks?: LongTaskItem[] } & ApiError;

export default function TasksClient(props: { locale: string; initial: unknown; initialStatus: number; initialQuery: { scope?: string | null; limit?: string | null; offset?: string | null } }) {
  const [data, setData] = useState<LongTasksResp | null>((props.initial as LongTasksResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [page, setPage] = useState<number>(0);

  const pageSize = useMemo(() => {
    const n = Number(props.initialQuery.limit);
    return Number.isFinite(n) && n > 0 ? n : 20;
  }, [props.initialQuery.limit]);

  const items = useMemo(() => (Array.isArray(data?.longTasks) ? data!.longTasks! : []), [data]);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  const refresh = useCallback(async function () {
    setError("");
    const q = new URLSearchParams();
    if (props.initialQuery.scope) q.set("scope", props.initialQuery.scope);
    q.set("limit", String(pageSize));
    q.set("offset", String(page * pageSize));
    const res = await apiFetch(`/tasks/long-tasks?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as LongTasksResp) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.initialQuery.scope, pageSize, page, props.locale]);

  /* Auto-reload when page changes (skip initial) */
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized) { setInitialized(true); return; }
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

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

  async function continueAgentRun(taskId: string, runId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/agent-runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "tasks.title")}
        actions={
          <>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "tasks.listTitle")}>
          <Table>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "tasks.col.taskId")}</th>
                <th align="left">{t(props.locale, "tasks.col.title")}</th>
                <th align="left">{t(props.locale, "tasks.col.phase")}</th>
                <th align="left">{t(props.locale, "tasks.col.run")}</th>
                <th align="left">{t(props.locale, "tasks.col.status")}</th>
                <th align="left">{t(props.locale, "tasks.col.jobType")}</th>
                <th align="left">{t(props.locale, "tasks.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.task.taskId}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    <Link href={`/tasks/${encodeURIComponent(it.task.taskId)}?lang=${encodeURIComponent(props.locale)}`}>{it.task.taskId}</Link>
                  </td>
                  <td>{it.task.title ?? "-"}</td>
                  <td>{it.progress.phase ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    {it.run?.runId ? <Link href={`/runs/${encodeURIComponent(it.run.runId)}?lang=${encodeURIComponent(props.locale)}`}>{it.run.runId}</Link> : "-"}
                  </td>
                  <td>{it.run ? <Badge>{it.run.status}</Badge> : "-"}</td>
                  <td>{it.run?.jobType ?? "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => it.run?.runId && cancelRun(it.run.runId)} disabled={busy || !it.controls.canCancel || !it.run?.runId}>
                        {t(props.locale, "action.cancel")}
                      </button>
                      <button
                        onClick={() => it.run?.runId && continueAgentRun(it.task.taskId, it.run.runId)}
                        disabled={busy || !it.controls.canContinue || !it.run?.runId}
                      >
                        {t(props.locale, "action.continue")}
                      </button>
                      {it.controls.needsApproval ? <Badge>{t(props.locale, "tasks.badge.needsApproval")}</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(page * pageSize + items.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
              <button disabled={busy || items.length < pageSize} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

