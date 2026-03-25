"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ExplainView = ApiError & {
  snapshotId?: string;
  tenantId?: string;
  spaceId?: string | null;
  resourceType?: string;
  action?: string;
  decision?: string;
  reason?: string | null;
  matchedRules?: unknown;
  rowFilters?: unknown;
  fieldRules?: unknown;
  createdAt?: string;
};

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

function jsonBlock(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function GovPolicySnapshotDetailClient(props: { locale: string; snapshotId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ExplainView | null>((props.initial as ExplainView) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/policy/snapshots/${encodeURIComponent(props.snapshotId)}/explain`, {
        locale: props.locale,
        cache: "no-store",
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setData((json as ExplainView) ?? null);
      if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
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

  async function copy(textVal: string) {
    try {
      await navigator.clipboard.writeText(textVal);
    } catch {}
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.policySnapshotDetail.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <a href={`/gov/policy-snapshots?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.back")}</a>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.metaTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.snapshotId")}</b>: {data?.snapshotId ?? props.snapshotId}{" "}
              <button onClick={() => copy(String(data?.snapshotId ?? props.snapshotId))} disabled={busy}>
                {t(props.locale, "action.copy")}
              </button>
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.createdAt")}</b>: {data?.createdAt ?? ""}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.resourceType")}</b>: {data?.resourceType ?? ""}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.action")}</b>: {data?.action ?? ""}
            </div>
            <div>
              <b>tenantId</b>: {data?.tenantId ?? ""}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.spaceId")}</b>: {data?.spaceId ?? ""}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.decisionTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.decision")}</b>: <Badge>{String(data?.decision ?? "")}</Badge>
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshotDetail.reason")}</b>: {data?.reason ? String(data.reason) : ""}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.rulesTitle")}>
          <details open>
            <summary>{t(props.locale, "gov.policySnapshotDetail.matchedRules")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.matchedRules ?? null)}</pre>
          </details>
          <details>
            <summary>{t(props.locale, "gov.policySnapshotDetail.fieldRules")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.fieldRules ?? null)}</pre>
          </details>
          <details>
            <summary>{t(props.locale, "gov.policySnapshotDetail.rowFilters")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.rowFilters ?? null)}</pre>
          </details>
        </Card>
      </div>
    </div>
  );
}

