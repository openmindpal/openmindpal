"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type EpochResponse = ApiError & { scopeType?: "tenant" | "space"; scopeId?: string; epoch?: number };
type EvalResponse =
  | (ApiError & { decision?: "allow" | "deny"; reason?: string | null; policySnapshotId?: string; matchedRulesSummary?: any; fieldRulesEffective?: any; rowFiltersEffective?: any; warnings?: string[] })
  | null;

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

export default function GovPolicyDebuggerClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [epochData, setEpochData] = useState<EpochResponse | null>((props.initial as EpochResponse) ?? null);
  const [epochStatus, setEpochStatus] = useState<number>(props.initialStatus);
  const [busyEpoch, setBusyEpoch] = useState<boolean>(false);
  const [epochError, setEpochError] = useState<string>("");

  const [scopeType, setScopeType] = useState<"space" | "tenant">("space");
  const [scopeId, setScopeId] = useState<string>("");
  const [invalidateReason, setInvalidateReason] = useState<string>("");

  const [evalBusy, setEvalBusy] = useState<boolean>(false);
  const [evalError, setEvalError] = useState<string>("");
  const [evalOut, setEvalOut] = useState<EvalResponse>(null);

  const [evalSubjectId, setEvalSubjectId] = useState<string>("");
  const [evalResourceType, setEvalResourceType] = useState<string>("governance");
  const [evalAction, setEvalAction] = useState<string>("policy_snapshot.read");

  const epochInitialError = useMemo(() => {
    if (epochStatus >= 400) return errText(props.locale, epochData);
    return "";
  }, [epochData, epochStatus, props.locale]);

  async function refreshEpoch() {
    setEpochError("");
    setBusyEpoch(true);
    try {
      const q = new URLSearchParams();
      if (scopeType) q.set("scopeType", scopeType);
      if (scopeId.trim()) q.set("scopeId", scopeId.trim());
      const res = await apiFetch(`/governance/policy/cache/epoch?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setEpochStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setEpochData((json as EpochResponse) ?? null);
    } catch (e: unknown) {
      setEpochError(errText(props.locale, toApiError(e)));
    } finally {
      setBusyEpoch(false);
    }
  }

  async function invalidateEpoch() {
    setEpochError("");
    setBusyEpoch(true);
    try {
      const st = scopeType === "tenant" ? "tenant" : "space";
      const res = await apiFetch(`/governance/policy/cache/invalidate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        cache: "no-store",
        body: JSON.stringify({ scopeType: st, scopeId: scopeId.trim(), reason: invalidateReason.trim() }),
      });
      setEpochStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEpoch();
    } catch (e: unknown) {
      setEpochError(errText(props.locale, toApiError(e)));
    } finally {
      setBusyEpoch(false);
    }
  }

  async function evalPolicy() {
    setEvalError("");
    setEvalBusy(true);
    try {
      const st = scopeType === "tenant" ? "tenant" : "space";
      const res = await apiFetch(`/governance/policy/debug/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        cache: "no-store",
        body: JSON.stringify({
          scopeType: st,
          scopeId: scopeId.trim(),
          subjectId: evalSubjectId.trim(),
          resourceType: evalResourceType.trim(),
          action: evalAction.trim(),
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setEvalOut((json as any) ?? null);
    } catch (e: unknown) {
      setEvalError(errText(props.locale, toApiError(e)));
    } finally {
      setEvalBusy(false);
    }
  }

  const snapshotHref = evalOut?.policySnapshotId ? `/gov/policy-snapshots/${encodeURIComponent(String(evalOut.policySnapshotId))}?lang=${encodeURIComponent(props.locale)}` : "";

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.policyDebugger.title")}
        actions={
          <>
            <Badge>{epochStatus}</Badge>
            <button onClick={refreshEpoch} disabled={busyEpoch}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {epochError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{epochError}</pre> : null}
      {!epochError && epochInitialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{epochInitialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policyDebugger.cacheTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.scopeType")}</span>
              <select value={scopeType} onChange={(e) => setScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busyEpoch || evalBusy}>
                <option value="space">{t(props.locale, "gov.policyDebugger.scopeSpace")}</option>
                <option value="tenant">{t(props.locale, "gov.policyDebugger.scopeTenant")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.scopeId")}</span>
              <input value={scopeId} onChange={(e) => setScopeId(e.target.value)} disabled={busyEpoch || evalBusy} />
            </label>
            <span>
              {t(props.locale, "gov.policyDebugger.epoch")}: <b>{String(epochData?.epoch ?? "")}</b>
            </span>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.invalidateReason")}</span>
              <input value={invalidateReason} onChange={(e) => setInvalidateReason(e.target.value)} disabled={busyEpoch} style={{ width: 420 }} />
            </label>
            <button onClick={invalidateEpoch} disabled={busyEpoch || !scopeId.trim() || !invalidateReason.trim()}>
              {t(props.locale, "gov.policyDebugger.invalidate")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policyDebugger.evalTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.subjectId")}</span>
              <input value={evalSubjectId} onChange={(e) => setEvalSubjectId(e.target.value)} disabled={evalBusy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.resourceType")}</span>
              <input value={evalResourceType} onChange={(e) => setEvalResourceType(e.target.value)} disabled={evalBusy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policyDebugger.action")}</span>
              <input value={evalAction} onChange={(e) => setEvalAction(e.target.value)} disabled={evalBusy} />
            </label>
            <button onClick={evalPolicy} disabled={evalBusy || !evalSubjectId.trim() || !scopeId.trim()}>
              {t(props.locale, "gov.policyDebugger.evaluate")}
            </button>
          </div>

          {evalError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 12 }}>{evalError}</pre> : null}
          {evalOut ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>{t(props.locale, "gov.policyDebugger.decision")}:</span>
                <Badge>{String(evalOut.decision ?? "")}</Badge>
                <span>
                  {t(props.locale, "gov.policyDebugger.reason")}: {String(evalOut.reason ?? "")}
                </span>
                {snapshotHref ? (
                  <a href={snapshotHref} style={{ marginLeft: 8 }}>
                    {t(props.locale, "gov.policyDebugger.openSnapshot")}
                  </a>
                ) : null}
              </div>
              <pre style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{JSON.stringify(evalOut, null, 2)}</pre>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

