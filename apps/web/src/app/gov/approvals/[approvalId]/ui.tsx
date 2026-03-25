"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ApprovalDetail = ApiError & { approval?: unknown; run?: unknown; steps?: unknown[] };

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

export default function ApprovalDetailClient(props: { locale: string; approvalId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ApprovalDetail | null>((props.initial as ApprovalDetail) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [reason, setReason] = useState<string>("");

  const steps = useMemo(() => (Array.isArray(data?.steps) ? data!.steps! : []), [data]);

  async function refresh() {
    setError("");
    const res = await apiFetch(`/approvals/${encodeURIComponent(props.approvalId)}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ApprovalDetail) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function decide(decision: "approve" | "reject") {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/approvals/${encodeURIComponent(props.approvalId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ decision, reason: reason.trim() ? reason.trim() : undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.approvalDetail.title")}
        description={
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>approvalId={props.approvalId}</span>
        }
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvalDetail.actionsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.approvalDetail.reason")}</div>
              <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.approvalDetail.reasonPlaceholder")} />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => decide("approve")} disabled={busy}>
                {t(props.locale, "gov.approvalDetail.approve")}
              </button>
              <button onClick={() => decide("reject")} disabled={busy}>
                {t(props.locale, "gov.approvalDetail.reject")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvalDetail.approvalTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(data?.approval ?? null, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvalDetail.runTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(data?.run ?? null, null, 2)}</pre>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "gov.approvalDetail.stepsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">stepId</th>
              <th align="left">seq</th>
              <th align="left">status</th>
              <th align="left">toolRef</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, idx) => {
              const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
              const stepId = String(o.stepId ?? o.step_id ?? "");
              return (
                <tr key={`${stepId}:${idx}`}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{stepId || "-"}</td>
                  <td>{String(o.seq ?? "-")}</td>
                  <td>{String(o.status ?? "-")}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(o.toolRef ?? o.tool_ref ?? "-")}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

