"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { decryptOp, enqueueOp, listStoredOps, syncPull, syncPush, updateStoredOp, type SyncOp } from "@/lib/offline/syncClient";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export default function SyncDebugClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ops, setOps] = useState<any[]>([]);
  const [lastPush, setLastPush] = useState<any>(null);
  const [lastPull, setLastPull] = useState<any>(null);
  const [serverByKey, setServerByKey] = useState<Record<string, unknown>>({});

  const [clientId, setClientId] = useState("web_dev");
  const [deviceId, setDeviceId] = useState("");
  const [keyId, setKeyId] = useState("tenant_dev:space_dev");
  const [opJson, setOpJson] = useState(() =>
    JSON.stringify(
      {
        opId: crypto.randomUUID(),
        schemaName: "core",
        entityName: "entities",
        recordId: crypto.randomUUID(),
        baseVersion: null,
        patch: { title: t(props.locale, "gov.syncDebug.samplePatchTitle") },
      },
      null,
      2,
    ),
  );

  const conflictOps = useMemo(() => ops.filter((o) => String(o.status ?? "") === "conflict"), [ops]);

  async function refreshOps() {
    setError("");
    setBusy(true);
    try {
      const rows = await listStoredOps();
      setOps(rows);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function addOp() {
    setError("");
    setBusy(true);
    try {
      const parsed = JSON.parse(opJson) as SyncOp;
      if (!parsed.opId) parsed.opId = crypto.randomUUID();
      await enqueueOp({ locale: props.locale, keyId, op: parsed });
      await refreshOps();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function doPush() {
    setError("");
    setBusy(true);
    try {
      const out = await syncPush({ locale: props.locale, keyId, clientId, deviceId: deviceId.trim() || undefined });
      setLastPush(out);
      if (!out.ok) setError(`${t(props.locale, "gov.syncDebug.pushFailed")}: ${out.status} ${JSON.stringify(out.body)}`);
      await refreshOps();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function doPull() {
    setError("");
    setBusy(true);
    try {
      const out = await syncPull({ locale: props.locale, clientId, limit: 50 });
      setLastPull(out);
      if (!out.ok) setError(`${t(props.locale, "gov.syncDebug.pullFailed")}: ${out.status} ${JSON.stringify(out.body)}`);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function rebaseConflict(op: any) {
    setError("");
    setBusy(true);
    try {
      const conflict = op?.conflict;
      const sr = conflict && typeof conflict === "object" ? (conflict as any).candidatesSummary : null;
      const serverRevision = sr ? Number((sr as any).serverRevision ?? NaN) : NaN;
      if (!Number.isFinite(serverRevision)) throw ({ errorCode: "ERROR", message: t(props.locale, "gov.syncDebug.error.missingServerRevision") } satisfies ApiError);
      const raw = ops.find((x) => String((x as any).opId ?? "") === String(op?.opId ?? ""));
      if (!raw) throw ({ errorCode: "ERROR", message: t(props.locale, "gov.syncDebug.error.missingOpRow") } satisfies ApiError);
      const decrypted = await decryptOp({ keyId, row: raw as any });
      const newOp: SyncOp = { ...decrypted, opId: crypto.randomUUID(), baseVersion: serverRevision };
      await enqueueOp({ locale: props.locale, keyId, op: newOp });
      setOpJson(JSON.stringify(newOp, null, 2));
      await refreshOps();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function discardOp(opId: string) {
    setError("");
    setBusy(true);
    try {
      await updateStoredOp({ opId, patch: { status: "rejected", conflict: null } as any });
      await refreshOps();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function manualMergeRebase(op: any) {
    setError("");
    setBusy(true);
    try {
      const conflict = op?.conflict;
      const sr = conflict && typeof conflict === "object" ? (conflict as any).candidatesSummary : null;
      const serverRevision = sr ? Number((sr as any).serverRevision ?? NaN) : NaN;
      if (!Number.isFinite(serverRevision)) throw ({ errorCode: "ERROR", message: t(props.locale, "gov.syncDebug.error.missingServerRevision") } satisfies ApiError);
      const parsed = JSON.parse(opJson) as SyncOp;
      if (!parsed || typeof parsed !== "object") throw ({ errorCode: "ERROR", message: t(props.locale, "gov.syncDebug.error.invalidOpJson") } satisfies ApiError);
      const meta = asRecord(op?.meta);
      const newOp: SyncOp = {
        opId: crypto.randomUUID(),
        schemaName: String(meta?.schemaName ?? parsed.schemaName ?? "core"),
        schemaVersion: parsed.schemaVersion,
        entityName: String(meta?.entityName ?? parsed.entityName ?? ""),
        recordId: String(meta?.recordId ?? parsed.recordId ?? ""),
        baseVersion: serverRevision,
        patch: parsed.patch ?? {},
        clock: parsed.clock,
      };
      await enqueueOp({ locale: props.locale, keyId, op: newOp });
      setOpJson(JSON.stringify(newOp, null, 2));
      await refreshOps();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function fetchServerRecord(entityName: string, recordId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/entities/${encodeURIComponent(entityName)}/${encodeURIComponent(recordId)}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json as unknown;
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function exportDebug() {
    const obj = { ops, lastPush, lastPull, serverByKey };
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sync-debug-${new Date().toISOString().replaceAll(":", "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.syncDebug.title")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled={busy} onClick={refreshOps}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
            <button disabled={busy} onClick={exportDebug}>
              {t(props.locale, "gov.syncDebug.export")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.syncDebug.configTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.syncDebug.clientId")}</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ width: 220 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.syncDebug.deviceId")}</span>
            <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={{ width: 220 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.syncDebug.keyId")}</span>
            <input value={keyId} onChange={(e) => setKeyId(e.target.value)} style={{ width: 260 }} />
          </label>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.syncDebug.enqueueOpTitle")}>
        <div style={{ display: "grid", gap: 10 }}>
          <textarea value={opJson} onChange={(e) => setOpJson(e.target.value)} rows={10} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button disabled={busy} onClick={addOp}>
              {t(props.locale, "action.create")}
            </button>
            <button disabled={busy} onClick={doPush}>
              {t(props.locale, "gov.syncDebug.push")}
            </button>
            <button disabled={busy} onClick={doPull}>
              {t(props.locale, "gov.syncDebug.pull")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.syncDebug.opsTitle")}>
        <Table header={<span>{ops.length ? `${ops.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th>{t(props.locale, "gov.syncDebug.table.opId")}</th>
              <th>{t(props.locale, "gov.syncDebug.table.status")}</th>
              <th>{t(props.locale, "gov.syncDebug.table.cursor")}</th>
              <th>{t(props.locale, "gov.syncDebug.table.meta")}</th>
              <th>{t(props.locale, "gov.syncDebug.table.conflict")}</th>
              <th>{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {ops.map((o) => {
              const id = String(o.opId ?? "");
              const meta = asRecord(o.meta);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>
                    <Badge>{String(o.status ?? "-")}</Badge>
                  </td>
                  <td>{o.cursor == null ? "-" : String(o.cursor)}</td>
                  <td>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(meta ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "gov.syncDebug.json")}</summary>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify({ conflict: o.conflict ?? null, ivB64: o.ivB64, ctB64: o.ctB64 }, null, 2)}</pre>
                    </details>
                    {o.conflict && typeof o.conflict === "object" ? (
                      <div style={{ marginTop: 6, opacity: 0.8 }}>
                        <span>{String((o.conflict as any).reason ?? "-")}</span>
                        <span style={{ marginLeft: 8 }}>{String((o.conflict as any).conflictType ?? "")}</span>
                        {Array.isArray((o.conflict as any).touchedFields) ? (
                          <span style={{ marginLeft: 8 }}>
                            {t(props.locale, "gov.syncDebug.fieldsCount")}={String(((o.conflict as any).touchedFields as any[]).length)}
                          </span>
                        ) : null}
                        {(o.conflict as any).candidatesSummary?.serverPayloadDigest12 ? (
                          <span style={{ marginLeft: 8 }}>
                            {t(props.locale, "gov.syncDebug.serverDigest")}={String((o.conflict as any).candidatesSummary.serverPayloadDigest12)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {String(o.status ?? "") === "conflict" ? (
                        <>
                          <button disabled={busy} onClick={() => rebaseConflict(o)}>
                            {t(props.locale, "gov.syncDebug.keepLocal")}
                          </button>
                          <button disabled={busy} onClick={() => manualMergeRebase(o)}>
                            {t(props.locale, "gov.syncDebug.manualMerge")}
                          </button>
                          <button disabled={busy} onClick={() => discardOp(id)}>
                            {t(props.locale, "gov.syncDebug.useServer")}
                          </button>
                        </>
                      ) : null}
                      {meta?.entityName && meta?.recordId ? (
                        <button
                          disabled={busy}
                          onClick={async () => {
                            const out = await fetchServerRecord(String(meta.entityName), String(meta.recordId));
                            if (!out) return;
                            const key = `${String(meta.entityName)}:${String(meta.recordId)}`;
                            setServerByKey((prev) => ({ ...prev, [key]: out }));
                          }}
                        >
                          {t(props.locale, "gov.syncDebug.server")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card title={t(props.locale, "gov.syncDebug.conflictsTitle")}>
        {conflictOps.length ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(conflictOps.map((x) => x.conflict ?? null), null, 2)}</pre> : <div style={{ opacity: 0.8 }}>-</div>}
      </Card>

      <Card title={t(props.locale, "gov.syncDebug.lastPushPullTitle")}>
        <details>
          <summary>{t(props.locale, "gov.syncDebug.push")}</summary>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(lastPush, null, 2)}</pre>
        </details>
        <details>
          <summary>{t(props.locale, "gov.syncDebug.pull")}</summary>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(lastPull, null, 2)}</pre>
        </details>
      </Card>

      <Card title={t(props.locale, "gov.syncDebug.serverRecordsTitle")}>
        {Object.keys(serverByKey).length ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(serverByKey, null, 2)}</pre> : <div style={{ opacity: 0.8 }}>-</div>}
      </Card>
    </div>
  );
}
