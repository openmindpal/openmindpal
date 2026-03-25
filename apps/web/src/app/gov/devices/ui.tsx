"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type Device = Record<string, unknown>;
type Artifact = Record<string, unknown>;

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export default function GovDevicesClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [ownerScope, setOwnerScope] = useState<"space" | "user">("space");
  const [devicesResp, setDevicesResp] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const devices = useMemo(() => (Array.isArray(devicesResp?.json?.devices) ? (devicesResp.json.devices as Device[]) : []), [devicesResp]);

  const [selectedId, setSelectedId] = useState("");
  const [detailResp, setDetailResp] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const device = useMemo(() => asRecord(detailResp?.json?.device), [detailResp]);
  const policy = useMemo(() => asRecord(detailResp?.json?.policy), [detailResp]);

  const [createDeviceType, setCreateDeviceType] = useState<"desktop" | "mobile">("desktop");
  const [createOs, setCreateOs] = useState("macOS");
  const [createAgentVersion, setCreateAgentVersion] = useState("0.1.0");
  const [createStatus, setCreateStatus] = useState(0);
  const [createResult, setCreateResult] = useState<any>(null);

  const [pairStatus, setPairStatus] = useState(0);
  const [pairResult, setPairResult] = useState<any>(null);

  const [policyJson, setPolicyJson] = useState<string>("{\"evidencePolicy\":{\"allowUpload\":true,\"allowedTypes\":[\"text/plain\"],\"retentionDays\":7}}");
  const [savePolicyStatus, setSavePolicyStatus] = useState(0);
  const [savePolicyResult, setSavePolicyResult] = useState<any>(null);

  const [evidenceResp, setEvidenceResp] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const evidenceItems = useMemo(() => (Array.isArray(evidenceResp?.json?.items) ? (evidenceResp.json.items as Artifact[]) : []), [evidenceResp]);
  const [downloadStatus, setDownloadStatus] = useState(0);
  const [downloadResult, setDownloadResult] = useState<any>(null);

  async function refreshDevices() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", "50");
      q.set("offset", "0");
      q.set("ownerScope", ownerScope);
      const res = await apiFetch(`/devices?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setDevicesResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
      const list = (json as any)?.devices;
      if (!selectedId && Array.isArray(list) && list.length) setSelectedId(String(list[0]?.deviceId ?? ""));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setDevicesResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function loadDetail(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setDetailResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
      const pol = (json as any)?.policy;
      if (pol && typeof pol === "object") {
        const next = {
          allowedTools: (pol as any).allowedTools ?? null,
          filePolicy: (pol as any).filePolicy ?? null,
          networkPolicy: (pol as any).networkPolicy ?? null,
          uiPolicy: (pol as any).uiPolicy ?? null,
          evidencePolicy: (pol as any).evidencePolicy ?? null,
          limits: (pol as any).limits ?? null,
        };
        setPolicyJson(JSON.stringify(next, null, 2));
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setDetailResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function createDevice() {
    setError("");
    setCreateResult(null);
    setCreateStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ ownerScope, deviceType: createDeviceType, os: createOs, agentVersion: createAgentVersion }),
      });
      setCreateStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateResult(json);
      await refreshDevices();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createPairing(deviceId: string) {
    setError("");
    setPairResult(null);
    setPairStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/pairing`, { method: "POST", locale: props.locale });
      setPairStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPairResult(json);
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshDevices();
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy(deviceId: string) {
    setError("");
    setSavePolicyResult(null);
    setSavePolicyStatus(0);
    setBusy(true);
    try {
      let obj: any = {};
      try {
        obj = JSON.parse(policyJson || "{}");
      } catch {
        obj = {};
      }
      const res = await apiFetch(`/devices/${encodeURIComponent(deviceId)}/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(obj),
      });
      setSavePolicyStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setSavePolicyResult(json);
      await loadDetail(deviceId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadEvidence(deviceId: string) {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("limit", "50");
      q.set("deviceId", deviceId);
      const res = await apiFetch(`/artifacts/device-evidence?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setEvidenceResp({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setEvidenceResp({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function createDownloadToken(artifactId: string) {
    setError("");
    setDownloadResult(null);
    setDownloadStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/artifacts/${encodeURIComponent(artifactId)}/download-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      setDownloadStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDownloadResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.devices")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={devicesResp.status} />
            <select value={ownerScope} onChange={(e) => setOwnerScope(e.target.value as any)} disabled={busy}>
              <option value="space">{t(props.locale, "gov.devices.ownerScope.space")}</option>
              <option value="user">{t(props.locale, "gov.devices.ownerScope.user")}</option>
            </select>
            <button disabled={busy} onClick={refreshDevices}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.devices.createTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={createDeviceType} onChange={(e) => setCreateDeviceType(e.target.value as any)} disabled={busy}>
            <option value="desktop">{t(props.locale, "gov.devices.deviceType.desktop")}</option>
            <option value="mobile">{t(props.locale, "gov.devices.deviceType.mobile")}</option>
          </select>
          <input value={createOs} onChange={(e) => setCreateOs(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.os")} disabled={busy} />
          <input value={createAgentVersion} onChange={(e) => setCreateAgentVersion(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.agentVersion")} disabled={busy} />
          <button disabled={busy} onClick={createDevice}>
            {t(props.locale, "action.create")}
          </button>
          {createStatus ? <StatusBadge locale={props.locale} status={createStatus} /> : null}
        </div>
        {createResult ? <pre style={{ margin: "8px 0 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(createResult, null, 2)}</pre> : null}
      </Card>

      <Card title={t(props.locale, "gov.devices.listTitle")}>
        <Table header={<span>{devices.length ? `${devices.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.devices.table.deviceId")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.deviceType")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.status")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.lastSeenAt")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.agentVersion")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d, idx) => {
              const rec = asRecord(d);
              const id = rec ? String(rec.deviceId ?? idx) : String(idx);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{rec ? String(rec.deviceType ?? "-") : "-"}</td>
                  <td>{rec ? <Badge>{String(rec.status ?? "-")}</Badge> : "-"}</td>
                  <td>{rec ? String(rec.lastSeenAt ?? rec.lastSeenAtMs ?? "-") : "-"}</td>
                  <td>{rec ? String(rec.agentVersion ?? "-") : "-"}</td>
                  <td>
                    <button
                      disabled={busy || !id}
                      onClick={async () => {
                        setSelectedId(id);
                        await loadDetail(id);
                      }}
                    >
                      {t(props.locale, "gov.devices.view")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card
        title={t(props.locale, "gov.devices.detailTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={detailResp.status} />
            <input value={selectedId} onChange={(e) => setSelectedId(e.currentTarget.value)} placeholder={t(props.locale, "gov.devices.placeholder.deviceId")} style={{ width: 420 }} disabled={busy} />
            <button disabled={busy || !selectedId.trim()} onClick={() => loadDetail(selectedId.trim())}>
              {t(props.locale, "action.load")}
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button disabled={busy || !selectedId.trim()} onClick={() => createPairing(selectedId.trim())}>
              {t(props.locale, "gov.devices.pairing")}
            </button>
            {pairStatus ? <StatusBadge locale={props.locale} status={pairStatus} /> : null}
            <button disabled={busy || !selectedId.trim()} onClick={() => revoke(selectedId.trim())}>
              {t(props.locale, "gov.devices.revoke")}
            </button>
          </div>
          {pairResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(pairResult, null, 2)}</pre> : null}
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify({ device, policy }, null, 2)}</pre>
        </div>
      </Card>

      <Card
        title={t(props.locale, "gov.devices.policyTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled={busy || !selectedId.trim()} onClick={() => savePolicy(selectedId.trim())}>
              {t(props.locale, "action.save")}
            </button>
            {savePolicyStatus ? <StatusBadge locale={props.locale} status={savePolicyStatus} /> : null}
          </div>
        }
      >
        <textarea value={policyJson} onChange={(e) => setPolicyJson(e.currentTarget.value)} disabled={busy} rows={8} style={{ width: "100%" }} />
        {savePolicyResult ? <pre style={{ margin: "8px 0 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(savePolicyResult, null, 2)}</pre> : null}
      </Card>

      <Card
        title={t(props.locale, "gov.devices.evidenceTitle")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={evidenceResp.status} />
            <button disabled={busy || !selectedId.trim()} onClick={() => loadEvidence(selectedId.trim())}>
              {t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      >
        <Table header={<span>{evidenceItems.length ? `${evidenceItems.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.devices.table.artifactId")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.type")}</th>
              <th align="left">{t(props.locale, "gov.devices.table.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {evidenceItems.map((a, idx) => {
              const rec = asRecord(a);
              const artifactId = rec ? String(rec.artifactId ?? idx) : String(idx);
              return (
                <tr key={artifactId}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{artifactId}</td>
                  <td>{rec ? String(rec.type ?? "-") : "-"}</td>
                  <td>{rec ? String(rec.createdAt ?? "-") : "-"}</td>
                  <td>
                    <button disabled={busy || !artifactId} onClick={() => createDownloadToken(artifactId)}>
                      {t(props.locale, "gov.devices.download")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>

        {downloadStatus ? <StatusBadge locale={props.locale} status={downloadStatus} /> : null}
        {downloadResult ? <pre style={{ margin: "8px 0 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(downloadResult, null, 2)}</pre> : null}
      </Card>
    </div>
  );
}

