"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type EvalRunResp = { run?: unknown } & ApiError;

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

export default function EvalRunClient(props: { locale: string; runId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<EvalRunResp | null>((props.initial as EvalRunResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/evals/runs/${encodeURIComponent(props.runId)}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setData((json as EvalRunResp) ?? null);
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.evalRun.title")}
        description={<span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>runId={props.runId}</span>}
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
        <Card title={t(props.locale, "gov.evalRun.summaryTitle")}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(data?.run ?? null, null, 2)}</pre>
        </Card>
      </div>
    </div>
  );
}
