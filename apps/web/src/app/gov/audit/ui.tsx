"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, TabNav } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type AuditEventRow = Record<string, unknown>;
type AuditListResponse = ApiError & { events?: AuditEventRow[] };
type AuditRetentionResponse = ApiError & { retentionDays?: number; updatedAt?: string | null };
type AuditLegalHoldRow = { holdId: string; scopeType: string; scopeId: string; status: string; reason: string; createdAt?: string | null };
type AuditLegalHoldsResponse = ApiError & { items?: AuditLegalHoldRow[] };
type AuditExportRow = { exportId: string; status: string; createdAt?: string | null; artifactId?: string | null; artifactRef?: string | null };
type AuditExportsResponse = ApiError & { items?: AuditExportRow[] };
type AuditExportCreateResponse = ApiError & { export?: AuditExportRow };
type AuditExportGetResponse = ApiError & { export?: AuditExportRow };
type ArtifactDownloadTokenResponse = ApiError & { token?: string; tokenId?: string; expiresAt?: string; downloadUrl?: string };
type AuditSiemDestinationRow = {
  id: string;
  name: string;
  enabled: boolean;
  secretId: string;
  batchSize: number;
  timeoutMs: number;
  updatedAt?: string | null;
};
type AuditSiemDestinationsResponse = ApiError & { items?: AuditSiemDestinationRow[] };
type AuditSiemDestinationCreateResponse = ApiError & { destination?: AuditSiemDestinationRow };
type AuditSiemDestinationUpdateResponse = ApiError & { destination?: AuditSiemDestinationRow };
type AuditSiemDestinationTestResponse = ApiError & { ok?: boolean; httpStatus?: number | null; deliveryId?: string; errorCode?: string; traceId?: string };
type AuditSiemDestinationBackfillResponse = ApiError & { ok?: boolean };
type AuditSiemDlqRow = { id: string; eventId: string; eventTs: string; attempts: number; createdAt?: string | null; lastErrorDigest?: unknown };
type AuditSiemDlqListResponse = ApiError & { items?: AuditSiemDlqRow[] };
type AuditSiemDlqOpResponse = ApiError & { ok?: boolean; deletedCount?: number; requeuedCount?: number };
type AuditVerifyResponse = ApiError & {
  ok?: boolean;
  checkedCount?: number;
  firstEventId?: string | null;
  lastEventId?: string | null;
  lastEventHash?: string | null;
  failures?: Array<{ eventId: string; reason: string }>;
};

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

export default function AuditClient(props: { locale: string }) {
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [traceId, setTraceId] = useState<string>("");
  const [subjectId, setSubjectId] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [limit, setLimit] = useState<string>("50");
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [eventsStatus, setEventsStatus] = useState<number>(0);

  const [verifyTenantId, setVerifyTenantId] = useState<string>("");
  const [verifyFrom, setVerifyFrom] = useState<string>("");
  const [verifyTo, setVerifyTo] = useState<string>("");
  const [verifyLimit, setVerifyLimit] = useState<string>("5000");
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResponse | null>(null);

  const [retentionDays, setRetentionDays] = useState<string>("0");
  const [retentionUpdatedAt, setRetentionUpdatedAt] = useState<string>("");

  const [holdScopeType, setHoldScopeType] = useState<"tenant" | "space">("tenant");
  const [holdScopeId, setHoldScopeId] = useState<string>("");
  const [holdFrom, setHoldFrom] = useState<string>("");
  const [holdTo, setHoldTo] = useState<string>("");
  const [holdSubjectId, setHoldSubjectId] = useState<string>("");
  const [holdTraceId, setHoldTraceId] = useState<string>("");
  const [holdRunId, setHoldRunId] = useState<string>("");
  const [holdReason, setHoldReason] = useState<string>("");
  const [holds, setHolds] = useState<AuditLegalHoldRow[]>([]);

  const [exportFrom, setExportFrom] = useState<string>("");
  const [exportTo, setExportTo] = useState<string>("");
  const [exportSpaceId, setExportSpaceId] = useState<string>("");
  const [exportSubjectId, setExportSubjectId] = useState<string>("");
  const [exportAction, setExportAction] = useState<string>("");
  const [exportToolRef, setExportToolRef] = useState<string>("");
  const [exportWorkflowRef, setExportWorkflowRef] = useState<string>("");
  const [exportTraceId, setExportTraceId] = useState<string>("");
  const [exportLimit, setExportLimit] = useState<string>("2000");
  const [exports, setExports] = useState<AuditExportRow[]>([]);

  const [siemDestinations, setSiemDestinations] = useState<AuditSiemDestinationRow[]>([]);
  const [siemName, setSiemName] = useState<string>("");
  const [siemSecretId, setSiemSecretId] = useState<string>("");
  const [siemEnabled, setSiemEnabled] = useState<boolean>(false);
  const [siemBatchSize, setSiemBatchSize] = useState<string>("200");
  const [siemTimeoutMs, setSiemTimeoutMs] = useState<string>("5000");
  const [siemLastResult, setSiemLastResult] = useState<unknown>(null);
  const [siemDlqDestId, setSiemDlqDestId] = useState<string>("");
  const [siemDlqStatus, setSiemDlqStatus] = useState<number>(0);
  const [siemDlqItems, setSiemDlqItems] = useState<AuditSiemDlqRow[]>([]);
  const [siemDlqLastResult, setSiemDlqLastResult] = useState<unknown>(null);

  const eventRows = useMemo(() => events, [events]);
  const exportRows = useMemo(() => exports, [exports]);
  const holdRows = useMemo(() => holds, [holds]);
  const siemRows = useMemo(() => siemDestinations, [siemDestinations]);
  const siemDlqRows = useMemo(() => siemDlqItems, [siemDlqItems]);

  async function downloadArtifact(artifactId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/artifacts/${encodeURIComponent(artifactId)}/download-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ maxUses: 1, expiresInSec: 300 }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as ArtifactDownloadTokenResponse) ?? {};
      if (!out.downloadUrl) throw toApiError({ errorCode: "ERROR", message: "Missing downloadUrl" });
      window.open(`${API_BASE}${out.downloadUrl}`, "_blank");
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (traceId.trim()) q.set("traceId", traceId.trim());
      if (subjectId.trim()) q.set("subjectId", subjectId.trim());
      if (action.trim()) q.set("action", action.trim());
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
      const res = await apiFetch(`/audit?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setEventsStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditListResponse) ?? {};
      setEvents(Array.isArray(out.events) ? out.events : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError("");
    setBusy(true);
    setVerifyResult(null);
    try {
      const q = new URLSearchParams();
      if (verifyTenantId.trim()) q.set("tenantId", verifyTenantId.trim());
      if (verifyFrom.trim()) q.set("from", verifyFrom.trim());
      if (verifyTo.trim()) q.set("to", verifyTo.trim());
      const n = Number(verifyLimit);
      if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
      const res = await apiFetch(`/audit/verify?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setVerifyResult((json as AuditVerifyResponse) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadRetention() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/audit/retention`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditRetentionResponse) ?? {};
      setRetentionDays(String(out.retentionDays ?? 0));
      setRetentionUpdatedAt(out.updatedAt ? String(out.updatedAt) : "");
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention() {
    setError("");
    setBusy(true);
    try {
      const days = Number(retentionDays);
      const res = await apiFetch(`/audit/retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ retentionDays: Number.isFinite(days) ? days : 0 }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditRetentionResponse) ?? {};
      setRetentionDays(String(out.retentionDays ?? 0));
      setRetentionUpdatedAt(out.updatedAt ? String(out.updatedAt) : "");
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadHolds() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/audit/legal-holds?limit=50`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditLegalHoldsResponse) ?? {};
      setHolds(Array.isArray(out.items) ? out.items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createHold() {
    setError("");
    setBusy(true);
    try {
      const body = {
        scopeType: holdScopeType,
        scopeId: holdScopeType === "space" ? holdScopeId.trim() : undefined,
        from: holdFrom.trim() || undefined,
        to: holdTo.trim() || undefined,
        subjectId: holdSubjectId.trim() || undefined,
        traceId: holdTraceId.trim() || undefined,
        runId: holdRunId.trim() || undefined,
        reason: holdReason.trim(),
      };
      const res = await apiFetch(`/audit/legal-holds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await loadHolds();
      setHoldReason("");
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function releaseHold(holdId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/audit/legal-holds/${encodeURIComponent(holdId)}/release`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await loadHolds();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadExports() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/audit/exports?limit=50`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditExportsResponse) ?? {};
      setExports(Array.isArray(out.items) ? out.items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadSiemDestinations() {
    setError("");
    setBusy(true);
    setSiemLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations?limit=50`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditSiemDestinationsResponse) ?? {};
      setSiemDestinations(Array.isArray(out.items) ? out.items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createSiemDestination() {
    setError("");
    setBusy(true);
    setSiemLastResult(null);
    try {
      const batchSize = Number(siemBatchSize);
      const timeoutMs = Number(siemTimeoutMs);
      const res = await apiFetch(`/audit/siem-destinations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          name: siemName.trim(),
          secretId: siemSecretId.trim(),
          enabled: siemEnabled,
          batchSize: Number.isFinite(batchSize) ? batchSize : 200,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditSiemDestinationCreateResponse) ?? {};
      setSiemLastResult(out.destination ?? out);
      await loadSiemDestinations();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function updateSiemDestination(d: AuditSiemDestinationRow, patch: Partial<Pick<AuditSiemDestinationRow, "name" | "enabled" | "secretId" | "batchSize" | "timeoutMs">>) {
    setError("");
    setBusy(true);
    setSiemLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          id: d.id,
          name: patch.name ?? d.name,
          enabled: patch.enabled ?? d.enabled,
          secretId: patch.secretId ?? d.secretId,
          batchSize: patch.batchSize ?? d.batchSize,
          timeoutMs: patch.timeoutMs ?? d.timeoutMs,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditSiemDestinationUpdateResponse) ?? {};
      setSiemLastResult(out.destination ?? out);
      await loadSiemDestinations();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function testSiemDestination(id: string) {
    setError("");
    setBusy(true);
    setSiemLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations/${encodeURIComponent(id)}/test`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSiemLastResult((json as AuditSiemDestinationTestResponse) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function backfillSiemDestination(id: string) {
    setError("");
    setBusy(true);
    setSiemLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations/${encodeURIComponent(id)}/backfill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ clearOutbox: true }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSiemLastResult((json as AuditSiemDestinationBackfillResponse) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadSiemDlq(destinationId: string) {
    setError("");
    setBusy(true);
    setSiemDlqLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations/${encodeURIComponent(destinationId)}/dlq?limit=50`, { locale: props.locale, cache: "no-store" });
      setSiemDlqStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditSiemDlqListResponse) ?? {};
      setSiemDlqDestId(destinationId);
      setSiemDlqItems(Array.isArray(out.items) ? out.items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function clearSiemDlq(destinationId: string) {
    setError("");
    setBusy(true);
    setSiemDlqLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations/${encodeURIComponent(destinationId)}/dlq/clear`, { method: "POST", locale: props.locale });
      setSiemDlqStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSiemDlqLastResult((json as AuditSiemDlqOpResponse) ?? null);
      await loadSiemDlq(destinationId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function requeueSiemDlq(destinationId: string) {
    setError("");
    setBusy(true);
    setSiemDlqLastResult(null);
    try {
      const res = await apiFetch(`/audit/siem-destinations/${encodeURIComponent(destinationId)}/dlq/requeue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ limit: 200 }),
      });
      setSiemDlqStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSiemDlqLastResult((json as AuditSiemDlqOpResponse) ?? null);
      await loadSiemDlq(destinationId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createExport() {
    setError("");
    setBusy(true);
    try {
      const body = {
        from: exportFrom.trim() || undefined,
        to: exportTo.trim() || undefined,
        spaceId: exportSpaceId.trim() || undefined,
        subjectId: exportSubjectId.trim() || undefined,
        action: exportAction.trim() || undefined,
        toolRef: exportToolRef.trim() || undefined,
        workflowRef: exportWorkflowRef.trim() || undefined,
        traceId: exportTraceId.trim() || undefined,
        limit: Number(exportLimit) || undefined,
      };
      const res = await apiFetch(`/audit/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditExportCreateResponse) ?? {};
      if (out.export) setExports([out.export, ...exportRows]);
      else await loadExports();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function refreshExport(exportId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/audit/exports/${encodeURIComponent(exportId)}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as AuditExportGetResponse) ?? {};
      const updated = out.export;
      if (updated) {
        setExports((prev) => prev.map((it) => (it.exportId === exportId ? updated : it)));
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.audit.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={eventsStatus} />
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <TabNav tabs={[
          {
            key: "query",
            label: t(props.locale, "gov.audit.tab.query"),
            content: (
              <>
                <Card title={t(props.locale, "gov.audit.queryTitle")}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.traceId")}</span>
                      <input value={traceId} onChange={(e) => setTraceId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.subjectId")}</span>
                      <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.action")}</span>
                      <input value={action} onChange={(e) => setAction(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.limit")}</span>
                      <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy} style={{ width: 100 }} />
                    </label>
                    <button onClick={search} disabled={busy}>
                      {t(props.locale, "action.apply")}
                    </button>
                  </div>
                </Card>

                <div style={{ marginTop: 16 }}>
                  <Table
                    header={
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <span>{t(props.locale, "gov.audit.eventsTitle")}</span>
                        <Badge>{eventRows.length}</Badge>
                      </div>
                    }
                  >
                    <thead>
                      <tr>
                        <th align="left">{t(props.locale, "gov.audit.events.table.event_id")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.timestamp")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.subject_id")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.resource_type")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.action")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.result")}</th>
                        <th align="left">{t(props.locale, "gov.audit.events.table.trace_id")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eventRows.map((ev, idx) => (
                        <tr key={`${String(ev.event_id ?? "")}:${idx}`}>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(ev.event_id ?? "")}</td>
                          <td>{String(ev.timestamp ?? "")}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(ev.subject_id ?? "")}</td>
                          <td>{String(ev.resource_type ?? "")}</td>
                          <td>{String(ev.action ?? "")}</td>
                          <td>{String(ev.result ?? "")}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(ev.trace_id ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            ),
          },
          {
            key: "retention",
            label: t(props.locale, "gov.audit.tab.retention"),
            content: (
              <Card
                title={t(props.locale, "gov.audit.retentionTitle")}
                footer={
                  <span>
                    {t(props.locale, "gov.audit.footer.updatedAt")}={retentionUpdatedAt || "-"}
                  </span>
                }
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span>{t(props.locale, "gov.audit.retentionDays")}</span>
                    <input value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} disabled={busy} style={{ width: 120 }} />
                  </label>
                  <button onClick={loadRetention} disabled={busy}>
                    {t(props.locale, "action.refresh")}
                  </button>
                  <button onClick={saveRetention} disabled={busy}>
                    {t(props.locale, "action.save")}
                  </button>
                </div>
              </Card>
            ),
          },
          {
            key: "holds",
            label: t(props.locale, "gov.audit.tab.legalHolds"),
            content: (
              <Card
                title={t(props.locale, "gov.audit.legalHoldsTitle")}
                footer={
                  <span>
                    {t(props.locale, "gov.audit.footer.count")}={holdRows.length}
                  </span>
                }
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.scopeType")}</span>
                      <select value={holdScopeType} onChange={(e) => setHoldScopeType(e.target.value === "space" ? "space" : "tenant")} disabled={busy}>
                        <option value="tenant">{t(props.locale, "gov.audit.scope.tenant")}</option>
                        <option value="space">{t(props.locale, "gov.audit.scope.space")}</option>
                      </select>
                    </label>
                    {holdScopeType === "space" ? (
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span>{t(props.locale, "gov.audit.scopeId")}</span>
                        <input value={holdScopeId} onChange={(e) => setHoldScopeId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                      </label>
                    ) : null}
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.from")}</span>
                      <input value={holdFrom} onChange={(e) => setHoldFrom(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.to")}</span>
                      <input value={holdTo} onChange={(e) => setHoldTo(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.subjectId")}</span>
                      <input value={holdSubjectId} onChange={(e) => setHoldSubjectId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.traceId")}</span>
                      <input value={holdTraceId} onChange={(e) => setHoldTraceId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.runId")}</span>
                      <input value={holdRunId} onChange={(e) => setHoldRunId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.reason")}</span>
                      <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} disabled={busy} style={{ width: 520 }} />
                    </label>
                    <button onClick={createHold} disabled={busy || !holdReason.trim() || (holdScopeType === "space" && !holdScopeId.trim())}>
                      {t(props.locale, "action.create")}
                    </button>
                    <button onClick={loadHolds} disabled={busy}>
                      {t(props.locale, "action.refresh")}
                    </button>
                  </div>

                  {holdRows.length ? (
                    <Table header={<span>{t(props.locale, "gov.audit.legalHoldsListTitle")}</span>}>
                      <thead>
                        <tr>
                          <th align="left">{t(props.locale, "gov.audit.table.holdId")}</th>
                          <th align="left">{t(props.locale, "gov.audit.table.scope")}</th>
                          <th align="left">{t(props.locale, "gov.audit.table.status")}</th>
                          <th align="left">{t(props.locale, "gov.audit.reason")}</th>
                          <th align="left">{t(props.locale, "gov.audit.createdAt")}</th>
                          <th align="left">{t(props.locale, "gov.audit.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {holdRows.map((h) => (
                          <tr key={h.holdId}>
                            <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{h.holdId}</td>
                            <td>{`${h.scopeType}:${h.scopeId}`}</td>
                            <td>{h.status}</td>
                            <td>{h.reason}</td>
                            <td>{h.createdAt ?? "-"}</td>
                            <td>
                              <button onClick={() => releaseHold(h.holdId)} disabled={busy || h.status !== "active"}>
                                {t(props.locale, "action.release")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : null}
                </div>
              </Card>
            ),
          },
          {
            key: "exports",
            label: t(props.locale, "gov.audit.tab.exports"),
            content: (
              <Card
                title={t(props.locale, "gov.audit.exportsTitle")}
                footer={
                  <span>
                    {t(props.locale, "gov.audit.footer.count")}={exportRows.length}
                  </span>
                }
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.from")}</span>
                      <input value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.to")}</span>
                      <input value={exportTo} onChange={(e) => setExportTo(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.spaceId")}</span>
                      <input value={exportSpaceId} onChange={(e) => setExportSpaceId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.subjectId")}</span>
                      <input value={exportSubjectId} onChange={(e) => setExportSubjectId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.action")}</span>
                      <input value={exportAction} onChange={(e) => setExportAction(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.toolRef")}</span>
                      <input value={exportToolRef} onChange={(e) => setExportToolRef(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.workflowRef")}</span>
                      <input value={exportWorkflowRef} onChange={(e) => setExportWorkflowRef(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.traceId")}</span>
                      <input value={exportTraceId} onChange={(e) => setExportTraceId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.limit")}</span>
                      <input value={exportLimit} onChange={(e) => setExportLimit(e.target.value)} disabled={busy} style={{ width: 120 }} />
                    </label>
                    <button onClick={createExport} disabled={busy}>
                      {t(props.locale, "gov.audit.exportCreate")}
                    </button>
                    <button onClick={loadExports} disabled={busy}>
                      {t(props.locale, "action.refresh")}
                    </button>
                  </div>

                  {exportRows.length ? (
                    <Table header={<span>{t(props.locale, "gov.audit.exportsListTitle")}</span>}>
                      <thead>
                        <tr>
                          <th align="left">{t(props.locale, "gov.audit.table.exportId")}</th>
                          <th align="left">{t(props.locale, "gov.audit.table.status")}</th>
                          <th align="left">{t(props.locale, "gov.audit.createdAt")}</th>
                          <th align="left">{t(props.locale, "gov.audit.table.artifact")}</th>
                          <th align="left">{t(props.locale, "gov.audit.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exportRows.map((ex) => (
                          <tr key={ex.exportId}>
                            <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{ex.exportId}</td>
                            <td>{ex.status}</td>
                            <td>{ex.createdAt ?? "-"}</td>
                            <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                              {ex.artifactId ? (
                                <button onClick={() => downloadArtifact(ex.artifactId!)} disabled={busy}>
                                  {ex.artifactRef ?? ex.artifactId}
                                </button>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td>
                              <button onClick={() => refreshExport(ex.exportId)} disabled={busy}>
                                {t(props.locale, "action.refresh")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : null}
                </div>
              </Card>
            ),
          },
          {
            key: "siem",
            label: t(props.locale, "gov.audit.tab.siem"),
            content: (
              <Card
                title={t(props.locale, "gov.audit.siemTitle")}
                footer={
                  <span>
                    {t(props.locale, "gov.audit.footer.count")}={siemRows.length}
                  </span>
                }
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button onClick={loadSiemDestinations} disabled={busy}>
                      {t(props.locale, "action.refresh")}
                    </button>
                    <span>{t(props.locale, "gov.audit.siem.dlq")}</span>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.siem.name")}</span>
                      <input value={siemName} onChange={(e) => setSiemName(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.siem.secretId")}</span>
                      <input value={siemSecretId} onChange={(e) => setSiemSecretId(e.target.value)} disabled={busy} style={{ width: 360 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.siem.field.batchSize")}</span>
                      <input value={siemBatchSize} onChange={(e) => setSiemBatchSize(e.target.value)} disabled={busy} style={{ width: 120 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.siem.field.timeoutMs")}</span>
                      <input value={siemTimeoutMs} onChange={(e) => setSiemTimeoutMs(e.target.value)} disabled={busy} style={{ width: 120 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={siemEnabled} onChange={(e) => setSiemEnabled(e.target.checked)} disabled={busy} />
                      <span>{t(props.locale, "gov.audit.siem.enabled")}</span>
                    </label>
                    <button onClick={createSiemDestination} disabled={busy || !siemName.trim() || !siemSecretId.trim()}>
                      {t(props.locale, "action.create")}
                    </button>
                  </div>

                  {siemRows.length ? (
                    <Table header={<span>{t(props.locale, "gov.audit.siem.listTitle")}</span>}>
                      <thead>
                        <tr>
                          <th align="left">{t(props.locale, "gov.audit.siem.table.id")}</th>
                          <th align="left">{t(props.locale, "gov.audit.siem.name")}</th>
                          <th align="left">{t(props.locale, "gov.audit.siem.enabled")}</th>
                          <th align="left">{t(props.locale, "gov.audit.siem.secretId")}</th>
                          <th align="left">{t(props.locale, "gov.audit.siem.table.batchSize")}</th>
                          <th align="left">{t(props.locale, "gov.audit.siem.table.timeoutMs")}</th>
                          <th align="left">{t(props.locale, "gov.audit.updatedAt")}</th>
                          <th align="left">{t(props.locale, "gov.audit.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {siemRows.map((d) => (
                          <tr key={d.id}>
                            <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{d.id}</td>
                            <td>{d.name}</td>
                            <td>
                              <input
                                type="checkbox"
                                checked={Boolean(d.enabled)}
                                disabled={busy}
                                onChange={(e) => updateSiemDestination(d, { enabled: e.target.checked })}
                              />
                            </td>
                            <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{d.secretId}</td>
                            <td>
                              <input
                                defaultValue={String(d.batchSize)}
                                disabled={busy}
                                style={{ width: 90 }}
                                onBlur={(e) => {
                                  const n = Number(e.target.value);
                                  if (Number.isFinite(n) && n > 0) updateSiemDestination(d, { batchSize: n });
                                }}
                              />
                            </td>
                            <td>
                              <input
                                defaultValue={String(d.timeoutMs)}
                                disabled={busy}
                                style={{ width: 90 }}
                                onBlur={(e) => {
                                  const n = Number(e.target.value);
                                  if (Number.isFinite(n) && n > 0) updateSiemDestination(d, { timeoutMs: n });
                                }}
                              />
                            </td>
                            <td>{d.updatedAt ?? "-"}</td>
                            <td>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button onClick={() => testSiemDestination(d.id)} disabled={busy}>
                                  {t(props.locale, "gov.audit.siem.test")}
                                </button>
                                <button onClick={() => backfillSiemDestination(d.id)} disabled={busy}>
                                  {t(props.locale, "gov.audit.siem.backfill")}
                                </button>
                                <button onClick={() => loadSiemDlq(d.id)} disabled={busy}>
                                  {t(props.locale, "gov.audit.siem.dlq")}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : null}

                  {siemLastResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(siemLastResult, null, 2)}</pre> : null}
                  {siemDlqDestId ? (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <span>
                          {t(props.locale, "gov.audit.siem.dlq")} destId=
                          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{siemDlqDestId}</span>
                        </span>
                        <span>{t(props.locale, "gov.audit.footer.status")}={siemDlqStatus || "-"}</span>
                        <span>{t(props.locale, "gov.audit.footer.count")}={siemDlqRows.length}</span>
                        <button onClick={() => loadSiemDlq(siemDlqDestId)} disabled={busy}>
                          {t(props.locale, "action.refresh")}
                        </button>
                        <button onClick={() => requeueSiemDlq(siemDlqDestId)} disabled={busy}>
                          {t(props.locale, "gov.audit.siem.dlqRequeue")}
                        </button>
                        <button onClick={() => clearSiemDlq(siemDlqDestId)} disabled={busy}>
                          {t(props.locale, "gov.audit.siem.dlqClear")}
                        </button>
                      </div>

                      {siemDlqRows.length ? (
                        <Table header={<span>{t(props.locale, "gov.audit.siem.dlqListTitle")}</span>}>
                          <thead>
                            <tr>
                              <th align="left">{t(props.locale, "gov.audit.dlq.table.eventId")}</th>
                              <th align="left">{t(props.locale, "gov.audit.dlq.table.eventTs")}</th>
                              <th align="left">{t(props.locale, "gov.audit.dlq.table.attempts")}</th>
                              <th align="left">{t(props.locale, "gov.audit.dlq.table.createdAt")}</th>
                              <th align="left">{t(props.locale, "gov.audit.dlq.table.lastErrorDigest")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {siemDlqRows.map((x) => (
                              <tr key={x.id}>
                                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{x.eventId}</td>
                                <td>{x.eventTs}</td>
                                <td>{String(x.attempts)}</td>
                                <td>{x.createdAt ?? "-"}</td>
                                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                                  {x.lastErrorDigest ? JSON.stringify(x.lastErrorDigest) : "-"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </Table>
                      ) : null}

                      {siemDlqLastResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(siemDlqLastResult, null, 2)}</pre> : null}
                    </div>
                  ) : null}
                </div>
              </Card>
            ),
          },
          {
            key: "verify",
            label: t(props.locale, "gov.audit.tab.verify"),
            content: (
              <Card
                title={t(props.locale, "gov.audit.verifyTitle")}
                footer={
                  <span>
                    {t(props.locale, "gov.audit.footer.ok")}={String(verifyResult?.ok ?? "")} {t(props.locale, "gov.audit.footer.checkedCount")}={String(verifyResult?.checkedCount ?? "")} {t(props.locale, "gov.audit.footer.lastEventHash")}=
                    {String(verifyResult?.lastEventHash ?? "")}
                  </span>
                }
              >
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.tenantId")}</span>
                      <input value={verifyTenantId} onChange={(e) => setVerifyTenantId(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.from")}</span>
                      <input value={verifyFrom} onChange={(e) => setVerifyFrom(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.field.to")}</span>
                      <input value={verifyTo} onChange={(e) => setVerifyTo(e.target.value)} disabled={busy} style={{ width: 220 }} />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span>{t(props.locale, "gov.audit.limit")}</span>
                      <input value={verifyLimit} onChange={(e) => setVerifyLimit(e.target.value)} disabled={busy} style={{ width: 120 }} />
                    </label>
                    <button onClick={verify} disabled={busy}>
                      {t(props.locale, "gov.audit.verify")}
                    </button>
                  </div>
                  {verifyResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(verifyResult, null, 2)}</pre> : null}
                </div>
              </Card>
            ),
          },
        ]} />
      </div>
    </div>
  );
}
