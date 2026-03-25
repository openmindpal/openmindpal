"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type Runner = { runnerId: string; endpoint: string; enabled: boolean; authSecretId: string | null; capabilities: any | null; createdAt: string; updatedAt: string };
type ListResp = ApiError & { items?: Runner[] };

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

export default function SkillRuntimeClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(0);
  const [data, setData] = useState<ListResp | null>(null);
  const [error, setError] = useState("");

  const [endpoint, setEndpoint] = useState("");
  const [authSecretId, setAuthSecretId] = useState("");
  const [createStatus, setCreateStatus] = useState(0);
  const [createResult, setCreateResult] = useState<any>(null);

  const [testResult, setTestResult] = useState<any>(null);
  const [testStatus, setTestStatus] = useState(0);

  const runners = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/skill-runtime/runners`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as ListResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setData(null);
    } finally {
      setBusy(false);
    }
  }

  async function createRunner() {
    setError("");
    setCreateResult(null);
    setCreateStatus(0);
    const ep = endpoint.trim();
    if (!ep) return;
    setBusy(true);
    try {
      const body: any = { endpoint: ep, enabled: true };
      if (authSecretId.trim()) body.authSecretId = authSecretId.trim();
      const res = await apiFetch(`/governance/skill-runtime/runners`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(body),
      });
      setCreateStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateResult(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRunner(runnerId: string, enabled: boolean) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/skill-runtime/runners/${encodeURIComponent(runnerId)}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
        locale: props.locale,
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

  async function testRunner(runnerId: string) {
    setError("");
    setTestResult(null);
    setTestStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/skill-runtime/runners/${encodeURIComponent(runnerId)}/test`, {
        method: "POST",
        locale: props.locale,
      });
      setTestStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setTestResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.skillRuntime")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{status || "-"}</Badge>
            <button disabled={busy} onClick={refresh}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.skillRuntime.runners")}>
        <Table header={<span>{runners.length ? `${runners.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.skillRuntime.table.runnerId")}</th>
              <th align="left">{t(props.locale, "gov.skillRuntime.table.endpoint")}</th>
              <th align="left">{t(props.locale, "settings.schedules.table.status")}</th>
              <th align="left">{t(props.locale, "gov.skillRuntime.table.authSecretId")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {runners.map((r) => (
              <tr key={r.runnerId}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.runnerId}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.endpoint}</td>
                <td>
                  <Badge>{r.enabled ? t(props.locale, "status.enabled") : t(props.locale, "status.disabled")}</Badge>
                </td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.authSecretId ?? "-"}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button disabled={busy} onClick={() => testRunner(r.runnerId)}>
                      {t(props.locale, "gov.skillRuntime.test")}
                    </button>
                    <button disabled={busy} onClick={() => toggleRunner(r.runnerId, !r.enabled)}>
                      {r.enabled ? t(props.locale, "action.disable") : t(props.locale, "settings.action.enable")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card title={t(props.locale, "gov.skillRuntime.create")}>
        <div style={{ display: "grid", gap: 8, maxWidth: 900 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.skillRuntime.endpointLabel")}</div>
            <input value={endpoint} onChange={(e) => setEndpoint(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillRuntime.endpointPlaceholder")} disabled={busy} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.skillRuntime.authSecretIdLabel")}</div>
            <input value={authSecretId} onChange={(e) => setAuthSecretId(e.currentTarget.value)} placeholder={t(props.locale, "gov.skillRuntime.authSecretIdPlaceholder")} disabled={busy} />
          </label>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button disabled={busy || !endpoint.trim()} onClick={createRunner}>
              {busy ? t(props.locale, "action.creating") : t(props.locale, "action.create")}
            </button>
            {createStatus ? <Badge>{createStatus}</Badge> : null}
          </div>
          {createResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(createResult, null, 2)}</pre> : null}
        </div>
      </Card>

      <Card
        title={t(props.locale, "gov.skillRuntime.lastTest")}
        footer={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{testStatus || "-"}</Badge>
          </div>
        }
      >
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(testResult, null, 2)}</pre>
      </Card>
    </div>
  );
}

