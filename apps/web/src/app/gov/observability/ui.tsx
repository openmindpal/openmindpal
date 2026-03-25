"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

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

type Summary = any;

export default function GovObservabilityClient(props: { locale: string; initial: unknown; initialStatus: number; initialWindow: string }) {
  const [window, setWindow] = useState<string>(props.initialWindow || "1h");
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [data, setData] = useState<Summary | null>((props.initial as any) ?? null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data as any);
    return "";
  }, [data, props.locale, status]);

  async function refresh(nextWindow?: string) {
    setError("");
    setBusy(true);
    try {
      const w = nextWindow ?? window;
      const q = new URLSearchParams();
      q.set("window", w);
      const res = await apiFetch(`/governance/observability/summary?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData(json as any);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const routes: any[] = Array.isArray((data as any)?.routes) ? (data as any).routes : [];
  const sync: any[] = Array.isArray((data as any)?.sync) ? (data as any).sync : [];
  const topErrors: any[] = Array.isArray((data as any)?.topErrors) ? (data as any).topErrors : [];
  const knowledge = (data as any)?.knowledge ?? null;

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.observability.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.observability.window")}</span>
              <select
                value={window}
                onChange={(e) => {
                  const v = e.target.value === "24h" ? "24h" : "1h";
                  setWindow(v);
                  refresh(v);
                }}
                disabled={busy}
              >
                <option value="1h">1h</option>
                <option value="24h">24h</option>
              </select>
            </label>
            <button onClick={() => refresh()} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.routesTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.key")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.total")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.successRate")}</th>
                  <th style={{ textAlign: "right" }}>p50</th>
                  <th style={{ textAlign: "right" }}>p95</th>
                </tr>
              </thead>
              <tbody>
                {routes.slice(0, 30).map((r, idx) => {
                  const total = Number(r.total ?? 0);
                  const success = Number(r.success ?? 0);
                  const rate = total > 0 ? Math.round((success / total) * 10000) / 100 : 0;
                  return (
                    <tr key={`${r.key ?? idx}`}>
                      <td style={{ padding: "6px 4px" }}>{String(r.key ?? "")}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{total}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{rate.toFixed(2)}%</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.p50Ms == null ? "-" : `${Number(r.p50Ms)}ms`}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.p95Ms == null ? "-" : `${Number(r.p95Ms)}ms`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.syncTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.spaceId")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.pushes")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.ops")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.conflicts")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.conflictRate")}</th>
                </tr>
              </thead>
              <tbody>
                {sync.map((r, idx) => (
                  <tr key={`${r.spaceId ?? idx}`}>
                    <td style={{ padding: "6px 4px" }}>{String(r.spaceId ?? "")}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{Number(r.pushes ?? 0)}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{Number(r.ops ?? 0)}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{Number(r.conflicts ?? 0)}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.conflictRate == null ? "-" : String(r.conflictRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.knowledgeTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Badge>
              {t(props.locale, "gov.observability.searches")}: {String(knowledge?.searches ?? 0)}
            </Badge>
            <Badge>
              ok: {String(knowledge?.ok ?? 0)}
            </Badge>
            <Badge>
              denied: {String(knowledge?.denied ?? 0)}
            </Badge>
            <Badge>
              error: {String(knowledge?.error ?? 0)}
            </Badge>
            <Badge>
              empty: {String(knowledge?.emptyResults ?? 0)}
            </Badge>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.topErrorsTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.errorCategory")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.key")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.total")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.sampleTraceId")}</th>
                </tr>
              </thead>
              <tbody>
                {topErrors.map((r, idx) => {
                  const traceId = String(r.sampleTraceId ?? "");
                  const href = traceId ? `/gov/audit?lang=${encodeURIComponent(props.locale)}&traceId=${encodeURIComponent(traceId)}&limit=50` : "";
                  return (
                    <tr key={`${r.key ?? idx}-${idx}`}>
                      <td style={{ padding: "6px 4px" }}>{String(r.errorCategory ?? "")}</td>
                      <td style={{ padding: "6px 4px" }}>{String(r.key ?? "")}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{Number(r.count ?? 0)}</td>
                      <td style={{ padding: "6px 4px" }}>{href ? <a href={href}>{traceId}</a> : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

