"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ArtifactPolicy = ApiError & {
  tenantId?: string;
  scopeType?: "tenant" | "space";
  scopeId?: string;
  downloadTokenExpiresInSec?: number;
  downloadTokenMaxUses?: number;
  watermarkHeadersEnabled?: boolean;
  updatedAt?: string;
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

export default function GovArtifactPolicyClient(props: { locale: string; initial: unknown; initialStatus: number; initialScopeType: "space" | "tenant" }) {
  const [scopeType, setScopeType] = useState<"space" | "tenant">(props.initialScopeType);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [data, setData] = useState<ArtifactPolicy | null>((props.initial as ArtifactPolicy) ?? null);

  const initialExpiresInSec = props.initialStatus === 404 ? 300 : Number((props.initial as ArtifactPolicy | null)?.downloadTokenExpiresInSec ?? 300);
  const initialMaxUses = props.initialStatus === 404 ? 1 : Number((props.initial as ArtifactPolicy | null)?.downloadTokenMaxUses ?? 1);
  const initialWatermarkEnabled = props.initialStatus === 404 ? true : Boolean((props.initial as ArtifactPolicy | null)?.watermarkHeadersEnabled ?? true);
  const [expiresInSec, setExpiresInSec] = useState<string>(String(Number.isFinite(initialExpiresInSec) && initialExpiresInSec > 0 ? initialExpiresInSec : 300));
  const [maxUses, setMaxUses] = useState<string>(String(Number.isFinite(initialMaxUses) && initialMaxUses > 0 ? initialMaxUses : 1));
  const [watermarkHeadersEnabled, setWatermarkHeadersEnabled] = useState<boolean>(initialWatermarkEnabled);

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (status >= 400 && status !== 404) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  function loadFormFrom(p: ArtifactPolicy | null, isConfigured: boolean) {
    if (!isConfigured) {
      setExpiresInSec("300");
      setMaxUses("1");
      setWatermarkHeadersEnabled(true);
      return;
    }
    const e = Number(p?.downloadTokenExpiresInSec);
    const m = Number(p?.downloadTokenMaxUses);
    setExpiresInSec(String(Number.isFinite(e) && e > 0 ? e : 300));
    setMaxUses(String(Number.isFinite(m) && m > 0 ? m : 1));
    setWatermarkHeadersEnabled(Boolean(p?.watermarkHeadersEnabled ?? true));
  }

  async function load(nextScopeType?: "space" | "tenant") {
    const st = nextScopeType ?? scopeType;
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("scopeType", st);
      const res = await apiFetch(`/governance/artifact-policy?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 404) {
        setData((json as ArtifactPolicy) ?? null);
        loadFormFrom(null, false);
        return;
      }
      setData((json as ArtifactPolicy) ?? null);
      if (!res.ok) {
        setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
        return;
      }
      loadFormFrom((json as ArtifactPolicy) ?? null, true);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError("");
    setBusy(true);
    try {
      const e = Math.max(1, Math.min(3600, Math.floor(Number(expiresInSec || "0"))));
      const m = Math.max(1, Math.min(10, Math.floor(Number(maxUses || "0"))));
      const res = await apiFetch(`/governance/artifact-policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ scopeType, downloadTokenExpiresInSec: e, downloadTokenMaxUses: m, watermarkHeadersEnabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await load(scopeType);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.artifactPolicy.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={() => load()} disabled={busy}>
              {t(props.locale, "gov.artifactPolicy.load")}
            </button>
            <button onClick={save} disabled={busy}>
              {t(props.locale, "gov.artifactPolicy.save")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}
      {!error && status === 404 ? <pre style={{ whiteSpace: "pre-wrap" }}>{t(props.locale, "gov.artifactPolicy.notConfigured")}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.artifactPolicy.configTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.scopeType")}</div>
              <select
                value={scopeType}
                onChange={(e) => {
                  const v = e.target.value === "tenant" ? "tenant" : "space";
                  setScopeType(v);
                  load(v);
                }}
                disabled={busy}
              >
                <option value="space">space</option>
                <option value="tenant">tenant</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.expiresInSec")}</div>
              <input value={expiresInSec} onChange={(e) => setExpiresInSec(e.target.value)} disabled={busy} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.artifactPolicy.maxUses")}</div>
              <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={busy} />
            </label>

            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={watermarkHeadersEnabled} onChange={(e) => setWatermarkHeadersEnabled(e.target.checked)} disabled={busy} />
              <span>{t(props.locale, "gov.artifactPolicy.watermarkHeadersEnabled")}</span>
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => load()} disabled={busy}>
                {t(props.locale, "gov.artifactPolicy.load")}
              </button>
              <button onClick={save} disabled={busy}>
                {t(props.locale, "gov.artifactPolicy.save")}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
