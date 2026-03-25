"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type DeadletterRow = {
  jobId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  status?: string | null;
  attempt?: number | null;
  toolRef?: string | null;
  errorCategory?: string | null;
  lastErrorDigest?: unknown;
  deadletteredAt?: string | null;
  updatedAt?: string | null;
};
type DeadlettersResponse = ApiError & { deadletters?: DeadletterRow[] };

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

export default function DeadlettersClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<DeadlettersResponse | null>((props.initial as DeadlettersResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [toolRef, setToolRef] = useState<string>("");
  const [limit, setLimit] = useState<string>("50");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<string>("");

  const items = useMemo(() => (Array.isArray(data?.deadletters) ? data!.deadletters! : []), [data]);

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (toolRef.trim()) q.set("toolRef", toolRef.trim());
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await apiFetch(`/governance/workflow/deadletters?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as DeadlettersResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function retry(stepId: string) {
    setError("");
    setBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/deadletters/${encodeURIComponent(stepId)}/retry`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy("");
    }
  }

  async function cancel(stepId: string) {
    setError("");
    setBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/deadletters/${encodeURIComponent(stepId)}/cancel`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy("");
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.workflowDeadletters.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workflowDeadletters.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.workflowDeadletters.toolRef")}</span>
              <input value={toolRef} onChange={(e) => setToolRef(e.target.value)} style={{ width: 220 }} placeholder={t(props.locale, "gov.workflowDeadletters.toolRefPlaceholder")} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.workflowDeadletters.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 100 }} />
            </label>
            <button onClick={refresh}>{t(props.locale, "action.apply")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.workflowDeadletters.listTitle")}</span>
              <Badge>{items.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.col.stepId")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.col.runId")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.toolRef")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.deadletteredAt")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.errorCategory")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.lastErrorDigest")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d, idx) => {
              const stepId = d.stepId ?? "";
              const runId = d.runId ?? "";
              const disabled = busy && busy === stepId;
              return (
                <tr key={`${stepId}:${idx}`}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{stepId || "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{runId || "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{d.toolRef ?? "-"}</td>
                  <td>{d.deadletteredAt ?? "-"}</td>
                  <td>{d.errorCategory ?? "-"}</td>
                  <td>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(d.lastErrorDigest ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      {runId ? (
                        <Link href={`/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.open")}</Link>
                      ) : (
                        <span>-</span>
                      )}
                      {stepId ? (
                        <>
                          <button disabled={Boolean(disabled)} onClick={() => retry(stepId)}>
                            {t(props.locale, "gov.workflowDeadletters.action.retry")}
                          </button>
                          <button disabled={Boolean(disabled)} onClick={() => cancel(stepId)}>
                            {t(props.locale, "gov.workflowDeadletters.action.cancel")}
                          </button>
                        </>
                      ) : (
                        <span>-</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

