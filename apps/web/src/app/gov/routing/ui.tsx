"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RoutingPolicyRow = { purpose?: string; primaryModelRef?: string; fallbackModelRefs?: string[]; enabled?: boolean; updatedAt?: string };
type RoutingListResponse = ApiError & { policies?: RoutingPolicyRow[] };

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

export default function RoutingClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<RoutingListResponse | null>((props.initial as RoutingListResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [purpose, setPurpose] = useState<string>("");
  const [primaryModelRef, setPrimaryModelRef] = useState<string>("");
  const [fallbackText, setFallbackText] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean>(true);

  const policies = useMemo(() => (Array.isArray(data?.policies) ? data!.policies! : []), [data]);

  async function refresh() {
    setError("");
    const res = await fetch(`${API_BASE}/governance/model-gateway/routing?limit=200`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as RoutingListResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function upsert() {
    setError("");
    setBusy(true);
    try {
      const fallbacks = fallbackText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
      const res = await fetch(`${API_BASE}/governance/model-gateway/routing/${encodeURIComponent(purpose.trim())}`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ primaryModelRef: primaryModelRef.trim(), fallbackModelRefs: fallbacks, enabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPurpose("");
      setPrimaryModelRef("");
      setFallbackText("");
      setEnabled(true);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function disable(p: string) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/governance/model-gateway/routing/${encodeURIComponent(p)}/disable`, {
        method: "POST",
        headers: apiHeaders(props.locale),
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
        title={t(props.locale, "gov.routing.title")}
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
        <Card title={t(props.locale, "gov.routing.upsertTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 780 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.purpose")}</div>
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.routing.purposePlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.primaryModelRef")}</div>
              <input value={primaryModelRef} onChange={(e) => setPrimaryModelRef(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.routing.modelRefPlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.fallbackModelRefs")}</div>
              <input value={fallbackText} onChange={(e) => setFallbackText(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.routing.fallbackPlaceholder")} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
              <span>{t(props.locale, "gov.routing.enabled")}</span>
            </label>
            <div>
              <button onClick={upsert} disabled={busy || !purpose.trim() || !primaryModelRef.trim()}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "action.save")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.routing.listTitle")}</span>
              <Badge>{policies.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.routing.purpose")}</th>
              <th align="left">{t(props.locale, "gov.routing.primaryModelRef")}</th>
              <th align="left">{t(props.locale, "gov.routing.fallbackModelRefs")}</th>
              <th align="left">{t(props.locale, "gov.routing.enabled")}</th>
              <th align="left">{t(props.locale, "gov.routing.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.routing.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p, idx) => (
              <tr key={`${p.purpose ?? "x"}:${idx}`}>
                <td>{p.purpose ?? "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{p.primaryModelRef ?? "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  {Array.isArray(p.fallbackModelRefs) ? p.fallbackModelRefs.join(", ") : ""}
                </td>
                <td>{String(Boolean(p.enabled))}</td>
                <td>{p.updatedAt ?? "-"}</td>
                <td>
                  {p.purpose ? (
                    <button onClick={() => disable(p.purpose!)} disabled={busy}>
                      {t(props.locale, "action.disable")}
                    </button>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

