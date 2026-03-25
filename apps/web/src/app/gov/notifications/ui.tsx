"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, Table, StatusBadge, TabNav } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type OutboxItem = Record<string, unknown>;

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

export default function GovNotificationsClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [outboxStatus, setOutboxStatus] = useState<"deadletter" | "failed" | "queued" | "sent" | "canceled">("deadletter");
  const [outbox, setOutbox] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const outboxItems = useMemo(() => (Array.isArray(outbox?.json?.outbox) ? (outbox.json.outbox as OutboxItem[]) : []), [outbox]);

  const [templateId, setTemplateId] = useState("email.default");
  const [channel, setChannel] = useState("email");
  const [createTemplateStatus, setCreateTemplateStatus] = useState(0);
  const [createTemplateResult, setCreateTemplateResult] = useState<any>(null);

  const [versionTitle, setVersionTitle] = useState("Hello");
  const [versionBody, setVersionBody] = useState("Hi {{name}}");
  const [createVersionStatus, setCreateVersionStatus] = useState(0);
  const [createVersionResult, setCreateVersionResult] = useState<any>(null);

  const [publishVersion, setPublishVersion] = useState("1");
  const [publishStatus, setPublishStatus] = useState(0);
  const [publishResult, setPublishResult] = useState<any>(null);

  const [previewParams, setPreviewParams] = useState("{\"name\":\"world\"}");
  const [previewStatus, setPreviewStatus] = useState(0);
  const [previewResult, setPreviewResult] = useState<any>(null);

  async function refreshOutbox() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      q.set("status", outboxStatus);
      q.set("limit", "50");
      const res = await apiFetch(`/governance/notifications/outbox?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      setOutbox({ status: res.status, json });
      if (!res.ok) throw toApiError(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
      setOutbox({ status: 0, json: null });
    } finally {
      setBusy(false);
    }
  }

  async function retryOutbox(outboxId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/notifications/outbox/${encodeURIComponent(outboxId)}/retry`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function cancelOutbox(outboxId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/notifications/outbox/${encodeURIComponent(outboxId)}/cancel`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createTemplate() {
    setError("");
    setCreateTemplateResult(null);
    setCreateTemplateStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/notifications/templates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ templateId: templateId.trim(), channel }),
      });
      setCreateTemplateStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateTemplateResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createVersion() {
    setError("");
    setCreateVersionResult(null);
    setCreateVersionStatus(0);
    setBusy(true);
    try {
      const res = await apiFetch(`/notifications/templates/${encodeURIComponent(templateId.trim())}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ locale: props.locale, title: versionTitle, body: versionBody }),
      });
      setCreateVersionStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateVersionResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setError("");
    setPublishResult(null);
    setPublishStatus(0);
    const v = Number(publishVersion);
    if (!Number.isFinite(v)) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/notifications/templates/${encodeURIComponent(templateId.trim())}/versions/${encodeURIComponent(String(v))}/publish`, {
        method: "POST",
        locale: props.locale,
      });
      setPublishStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPublishResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    setError("");
    setPreviewResult(null);
    setPreviewStatus(0);
    setBusy(true);
    try {
      let params: any = {};
      try {
        params = JSON.parse(previewParams || "{}");
      } catch {
        params = {};
      }
      const res = await apiFetch(`/notifications/templates/${encodeURIComponent(templateId.trim())}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ locale: props.locale, params }),
      });
      setPreviewStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPreviewResult(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.notifications")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={outbox.status} />
            <button disabled={busy} onClick={refreshOutbox}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <TabNav tabs={[
        { key: "outbox", label: t(props.locale, "gov.notifications.tab.outbox"), content: (
          <Card title={t(props.locale, "gov.notifications.outboxTitle")}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <select value={outboxStatus} onChange={(e) => setOutboxStatus(e.target.value as any)} disabled={busy}>
                <option value="deadletter">{t(props.locale, "gov.notifications.status.deadletter")}</option>
                <option value="failed">{t(props.locale, "gov.notifications.status.failed")}</option>
                <option value="queued">{t(props.locale, "gov.notifications.status.queued")}</option>
                <option value="sent">{t(props.locale, "gov.notifications.status.sent")}</option>
                <option value="canceled">{t(props.locale, "gov.notifications.status.canceled")}</option>
              </select>
              <button disabled={busy} onClick={refreshOutbox}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
            <Table header={<span>{outboxItems.length ? `${outboxItems.length}` : "-"}</span>}>
              <thead>
                <tr>
                  <th align="left">{t(props.locale, "gov.notifications.col.outboxId")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.channel")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.templateId")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.version")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.recipientRef")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.status")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.attempt")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.nextAttemptAt")}</th>
                  <th align="left">{t(props.locale, "gov.notifications.col.lastError")}</th>
                  <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {outboxItems.map((o, idx) => (
                  <tr key={String((o as any).outboxId ?? idx)}>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String((o as any).outboxId ?? "")}</td>
                    <td>{String((o as any).channel ?? "")}</td>
                    <td>{String((o as any).templateId ?? "")}</td>
                    <td>{String((o as any).templateVersion ?? "")}</td>
                    <td>{String((o as any).recipientRef ?? "")}</td>
                    <td>{String((o as any).deliveryStatus ?? (o as any).status ?? "")}</td>
                    <td>{String((o as any).attemptCount ?? "")}</td>
                    <td>{String((o as any).nextAttemptAt ?? "")}</td>
                    <td>{String((o as any).lastErrorCategory ?? "")}{(o as any).lastErrorDigest ? `:${String((o as any).lastErrorDigest)}` : ""}</td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button disabled={busy || !String((o as any).outboxId ?? "")} onClick={() => retryOutbox(String((o as any).outboxId))}>
                          {t(props.locale, "gov.notifications.retry")}
                        </button>
                        <button disabled={busy || !String((o as any).outboxId ?? "")} onClick={() => cancelOutbox(String((o as any).outboxId))}>
                          {t(props.locale, "action.cancel")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )},
        { key: "templates", label: t(props.locale, "gov.notifications.tab.templates"), content: (
          <Card title={t(props.locale, "gov.notifications.templatesTitle")}>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.notifications.label.templateId")}</div>
                  <input value={templateId} onChange={(e) => setTemplateId(e.currentTarget.value)} disabled={busy} />
                </label>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.notifications.label.channel")}</div>
                  <select value={channel} onChange={(e) => setChannel(e.currentTarget.value)} disabled={busy}>
                    <option value="email">{t(props.locale, "gov.notifications.channel.email")}</option>
                    <option value="inapp">{t(props.locale, "gov.notifications.channel.inapp")}</option>
                    <option value="sms">{t(props.locale, "gov.notifications.channel.sms")}</option>
                  </select>
                </label>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button disabled={busy || !templateId.trim()} onClick={createTemplate}>
                    {t(props.locale, "gov.notifications.createTemplate")}
                  </button>
                  {createTemplateStatus ? <StatusBadge locale={props.locale} status={createTemplateStatus} /> : null}
                </div>
              </div>
              {createTemplateResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(createTemplateResult, null, 2)}</pre> : null}

              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <div>{t(props.locale, "gov.notifications.label.title")}</div>
                    <input value={versionTitle} onChange={(e) => setVersionTitle(e.currentTarget.value)} disabled={busy} />
                  </label>
                  <label style={{ display: "grid", gap: 6 }}>
                    <div>{t(props.locale, "gov.notifications.label.publishVersion")}</div>
                    <input value={publishVersion} onChange={(e) => setPublishVersion(e.currentTarget.value)} disabled={busy} />
                  </label>
                </div>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.notifications.label.body")}</div>
                  <textarea value={versionBody} onChange={(e) => setVersionBody(e.currentTarget.value)} disabled={busy} rows={4} />
                </label>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button disabled={busy || !templateId.trim()} onClick={createVersion}>
                    {t(props.locale, "gov.notifications.createVersion")}
                  </button>
                  {createVersionStatus ? <StatusBadge locale={props.locale} status={createVersionStatus} /> : null}
                  <button disabled={busy || !templateId.trim() || !publishVersion.trim()} onClick={publish}>
                    {t(props.locale, "gov.notifications.publishVersion")}
                  </button>
                  {publishStatus ? <StatusBadge locale={props.locale} status={publishStatus} /> : null}
                </div>
                {createVersionResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(createVersionResult, null, 2)}</pre> : null}
                {publishResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(publishResult, null, 2)}</pre> : null}
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <div>{t(props.locale, "gov.notifications.label.previewParams")}</div>
                  <textarea value={previewParams} onChange={(e) => setPreviewParams(e.currentTarget.value)} disabled={busy} rows={3} />
                </label>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <button disabled={busy || !templateId.trim()} onClick={preview}>
                    {t(props.locale, "gov.notifications.preview")}
                  </button>
                  {previewStatus ? <StatusBadge locale={props.locale} status={previewStatus} /> : null}
                </div>
                {previewResult ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(previewResult, null, 2)}</pre> : null}
              </div>
            </div>
          </Card>
        )},
      ]} />
    </div>
  );
}
