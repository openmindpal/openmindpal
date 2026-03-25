"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type LimitsResponse = ApiError & { scopeType?: string; scopeId?: string; quota?: { modelChatRpm?: number } | null; effective?: { modelChatRpm?: number | null; source?: string } };
type ToolLimitRow = { toolRef?: string; defaultMaxConcurrency?: number; updatedAt?: string };
type ToolLimitsResponse = ApiError & { toolLimits?: ToolLimitRow[] };

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

export default function QuotasClient(props: {
  locale: string;
  initialLimits: unknown;
  initialLimitsStatus: number;
  initialToolLimits: unknown;
  initialToolLimitsStatus: number;
}) {
  const [limits, setLimits] = useState<LimitsResponse | null>((props.initialLimits as LimitsResponse) ?? null);
  const [limitsStatus, setLimitsStatus] = useState<number>(props.initialLimitsStatus);
  const [toolLimits, setToolLimits] = useState<ToolLimitsResponse | null>((props.initialToolLimits as ToolLimitsResponse) ?? null);
  const [toolLimitsStatus, setToolLimitsStatus] = useState<number>(props.initialToolLimitsStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [scope, setScope] = useState<"space" | "tenant">("space");
  const [modelChatRpm, setModelChatRpm] = useState<string>("");

  const [toolRef, setToolRef] = useState<string>("");
  const [defaultMaxConcurrency, setDefaultMaxConcurrency] = useState<string>("");

  const rows = useMemo(() => (Array.isArray(toolLimits?.toolLimits) ? toolLimits!.toolLimits! : []), [toolLimits]);

  async function refreshLimits() {
    setError("");
    const res = await fetch(`${API_BASE}/governance/model-gateway/limits?scope=${encodeURIComponent(scope)}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setLimitsStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setLimits((json as LimitsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function refreshToolLimits() {
    setError("");
    const res = await fetch(`${API_BASE}/governance/tool-limits?limit=200`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setToolLimitsStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setToolLimits((json as ToolLimitsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function updateRpm() {
    setError("");
    setBusy(true);
    try {
      const rpm = Number(modelChatRpm);
      const res = await fetch(`${API_BASE}/governance/model-gateway/limits`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ scope, modelChatRpm: rpm }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setModelChatRpm("");
      await refreshLimits();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function updateToolLimit() {
    setError("");
    setBusy(true);
    try {
      const n = Number(defaultMaxConcurrency);
      const res = await fetch(`${API_BASE}/governance/tool-limits/${encodeURIComponent(toolRef.trim())}`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ defaultMaxConcurrency: n }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setToolRef("");
      setDefaultMaxConcurrency("");
      await refreshToolLimits();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialLimitsError = useMemo(() => {
    if (limitsStatus >= 400) return errText(props.locale, limits);
    return "";
  }, [limits, limitsStatus, props.locale]);

  const initialToolLimitsError = useMemo(() => {
    if (toolLimitsStatus >= 400) return errText(props.locale, toolLimits);
    return "";
  }, [props.locale, toolLimits, toolLimitsStatus]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.quotas.title")}
        actions={
          <>
            <Badge>{limitsStatus}</Badge>
            <Badge>{toolLimitsStatus}</Badge>
            <button
              onClick={async () => {
                await refreshLimits();
                await refreshToolLimits();
              }}
              disabled={busy}
            >
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialLimitsError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialLimitsError}</pre> : null}
      {!error && !initialLimitsError && initialToolLimitsError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialToolLimitsError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.quotas.modelChatTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{t(props.locale, "gov.quotas.scope")}</span>
                <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                  <option value="space">space</option>
                  <option value="tenant">tenant</option>
                </select>
              </label>
              <button onClick={refreshLimits} disabled={busy}>
                {t(props.locale, "action.apply")}
              </button>
            </div>
            <div>
              <Badge>
                {t(props.locale, "gov.quotas.effective")}: {String(limits?.effective?.modelChatRpm ?? "")} ({String(limits?.effective?.source ?? "")})
              </Badge>
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.quotas.modelChatRpm")}</div>
              <input value={modelChatRpm} onChange={(e) => setModelChatRpm(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.quotas.modelChatRpmPlaceholder")} />
            </label>
            <div>
              <button onClick={updateRpm} disabled={busy || !modelChatRpm.trim()}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "action.save")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.quotas.toolLimitsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.quotas.toolRef")}</div>
              <input value={toolRef} onChange={(e) => setToolRef(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.quotas.defaultMaxConcurrency")}</div>
              <input value={defaultMaxConcurrency} onChange={(e) => setDefaultMaxConcurrency(e.target.value)} disabled={busy} />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={updateToolLimit} disabled={busy || !toolRef.trim() || !defaultMaxConcurrency.trim()}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "action.save")}
              </button>
              <button onClick={refreshToolLimits} disabled={busy}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.quotas.toolLimitsList")}</span>
              <Badge>{rows.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.quotas.toolRef")}</th>
              <th align="left">{t(props.locale, "gov.quotas.defaultMaxConcurrency")}</th>
              <th align="left">{t(props.locale, "gov.quotas.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={`${r.toolRef ?? "x"}:${idx}`}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.toolRef ?? "-"}</td>
                <td>{String(r.defaultMaxConcurrency ?? "")}</td>
                <td>{r.updatedAt ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

