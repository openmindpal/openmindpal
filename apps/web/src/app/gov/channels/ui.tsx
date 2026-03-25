"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table, StatusBadge, TabNav } from "@/components/ui";

export default function GovChannelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [configs, setConfigs] = useState<{ status: number; json: any }>(props.initial?.configs ?? { status: 0, json: null });
  const [events, setEvents] = useState<{ status: number; json: any }>(props.initial?.events ?? { status: 0, json: null });
  const [outbox, setOutbox] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const [outboxStatus, setOutboxStatus] = useState<string>("deadletter");

  const cfgItems = useMemo(() => (Array.isArray(configs?.json?.configs) ? configs.json.configs : []), [configs]);
  const evItems = useMemo(() => (Array.isArray(events?.json?.events) ? events.json.events : []), [events]);
  const outboxItems = useMemo(() => (Array.isArray(outbox?.json?.messages) ? outbox.json.messages : []), [outbox]);

  const [provider, setProvider] = useState("feishu");
  const [workspaceId, setWorkspaceId] = useState("");
  const [secretEnvKey, setSecretEnvKey] = useState("");
  const [secretId, setSecretId] = useState("");
  const [appIdEnvKey, setAppIdEnvKey] = useState("");
  const [appSecretEnvKey, setAppSecretEnvKey] = useState("");
  const [spaceId, setSpaceId] = useState("");

  const [channelChatId, setChannelChatId] = useState("");
  const [defaultSubjectId, setDefaultSubjectId] = useState("");

  const [channelUserId, setChannelUserId] = useState("");
  const [subjectId, setSubjectId] = useState("");

  const [bindingResult, setBindingResult] = useState<{ authorizeUrl: string; expiresAt: string; bindingId: string } | null>(null);
  const [bindingStates, setBindingStates] = useState<any[]>([]);
  const [bindingCopied, setBindingCopied] = useState(false);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshConfigs = useCallback(async () => {
    const res = await apiFetch(`/governance/channels/webhook/configs?limit=50`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setConfigs({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  const [ingressStatus, setIngressStatus] = useState<string>("deadletter");

  const refreshEvents = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "20");
    if (ingressStatus.trim() && ingressStatus !== "all") q.set("status", ingressStatus.trim());
    const res = await apiFetch(`/governance/channels/ingress-events?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setEvents({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale, ingressStatus]);

  const refreshOutbox = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "50");
    if (outboxStatus.trim()) q.set("status", outboxStatus.trim());
    const res = await apiFetch(`/governance/channels/outbox?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setOutbox({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale, outboxStatus]);

  useEffect(() => {
    refreshConfigs();
    refreshEvents();
  }, [refreshConfigs, refreshEvents]);

  useEffect(() => {
    refreshOutbox();
  }, [refreshOutbox]);

  async function saveConfig() {
    await runAction(async () => {
      const providerConfig: any = {};
      if (provider === "feishu") {
        if (appIdEnvKey.trim()) providerConfig.appIdEnvKey = appIdEnvKey.trim();
        if (appSecretEnvKey.trim()) providerConfig.appSecretEnvKey = appSecretEnvKey.trim();
      }
      const res = await apiFetch(`/governance/channels/webhook/configs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          spaceId: spaceId.trim() || undefined,
          secretEnvKey: secretEnvKey.trim() || undefined,
          secretId: secretId.trim() || undefined,
          providerConfig: Object.keys(providerConfig).length ? providerConfig : undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshConfigs();
    });
  }

  async function testConfig() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ provider: provider.trim(), workspaceId: workspaceId.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(JSON.stringify(json ?? {}, null, 2));
    });
  }

  async function saveChatBinding() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          channelChatId: channelChatId.trim(),
          spaceId: spaceId.trim(),
          defaultSubjectId: defaultSubjectId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  async function retryIngress(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/ingress-events/${encodeURIComponent(id)}/retry`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  async function retryOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/retry`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    });
  }

  async function cancelOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/cancel`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    });
  }

  const refreshBindingStates = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "50");
    if (provider.trim()) q.set("provider", provider.trim());
    if (workspaceId.trim()) q.set("workspaceId", workspaceId.trim());
    const res = await apiFetch(`/governance/channels/binding/states?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (res.ok && Array.isArray(json?.states)) setBindingStates(json.states);
  }, [props.locale, provider, workspaceId]);

  async function initiateBinding() {
    await runAction(async () => {
      setBindingResult(null);
      setBindingCopied(false);
      const res = await apiFetch(`/governance/channels/binding/initiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          spaceId: spaceId.trim(),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setBindingResult({ authorizeUrl: json.authorizeUrl, expiresAt: json.expiresAt, bindingId: json.bindingId });
      await refreshBindingStates();
    });
  }

  async function saveAccountBinding() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          channelUserId: channelUserId.trim(),
          subjectId: subjectId.trim(),
          spaceId: spaceId.trim(),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.channels.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={configs.status} />
            <button onClick={refreshConfigs} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {info ? <pre style={{ color: "inherit", whiteSpace: "pre-wrap" }}>{info}</pre> : null}

      <TabNav tabs={[
        { key: "config", label: t(props.locale, "gov.channels.tab.config"), content: (
          <>
            <Card title={t(props.locale, "gov.channels.configTitle")}>
              <div style={{ display: "grid", gap: 10, maxWidth: 920 }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <div>{t(props.locale, "gov.channels.provider")}</div>
                  <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
                    <option value="feishu">{t(props.locale, "gov.channels.provider.feishu")}</option>
                    <option value="dingtalk">{t(props.locale, "gov.channels.provider.dingtalk")}</option>
                    <option value="wecom">{t(props.locale, "gov.channels.provider.wecom")}</option>
                    <option value="slack">{t(props.locale, "gov.channels.provider.slack")}</option>
                    <option value="discord">{t(props.locale, "gov.channels.provider.discord")}</option>
                    <option value="qq.onebot">{t(props.locale, "gov.channels.provider.qq.onebot")}</option>
                    <option value="imessage.bridge">{t(props.locale, "gov.channels.provider.imessage.bridge")}</option>
                  </select>
                  <div style={{ color: "#94a3b8", fontSize: 12 }}>{t(props.locale, "gov.channels.provider.hint")}</div>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <div>{t(props.locale, "gov.channels.workspaceId")}</div>
                  <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.workspaceId.hint")} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <div>{t(props.locale, "gov.channels.spaceId")}</div>
                  <input value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.spaceId.hint")} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <div>{t(props.locale, "gov.channels.secretEnvKey")}</div>
                  <input value={secretEnvKey} onChange={(e) => setSecretEnvKey(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.secretEnvKey.hint")} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <div>{t(props.locale, "gov.channels.secretId")}</div>
                  <input value={secretId} onChange={(e) => setSecretId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.secretId.hint")} />
                </label>
                {provider === "feishu" && (
                  <>
                    <label style={{ display: "grid", gap: 6 }}>
                      <div>{t(props.locale, "gov.channels.feishu.appIdEnvKey")}</div>
                      <input value={appIdEnvKey} onChange={(e) => setAppIdEnvKey(e.target.value)} disabled={busy} />
                    </label>
                    <label style={{ display: "grid", gap: 6 }}>
                      <div>{t(props.locale, "gov.channels.feishu.appSecretEnvKey")}</div>
                      <input value={appSecretEnvKey} onChange={(e) => setAppSecretEnvKey(e.target.value)} disabled={busy} />
                    </label>
                  </>
                )}
                <div>
                  <button onClick={saveConfig} disabled={busy || !provider.trim() || !workspaceId.trim() || (!secretEnvKey.trim() && !secretId.trim())}>
                    {t(props.locale, "action.save")}
                  </button>
                  <button onClick={testConfig} disabled={busy || !provider.trim() || !workspaceId.trim()} style={{ marginLeft: 8 }}>
                    {t(props.locale, "action.test")}
                  </button>
                </div>
              </div>
            </Card>
            <div style={{ marginTop: 16 }}>
              <Card title={t(props.locale, "gov.channels.mappingTitle")}>
                <div style={{ display: "grid", gap: 16, maxWidth: 920 }}>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 600 }}>{t(props.locale, "gov.channels.chatBinding")}</div>
                    <div style={{ color: "#64748b", fontSize: 13 }}>{t(props.locale, "gov.channels.chatBinding.desc")}</div>
                    <label style={{ display: "grid", gap: 4 }}>
                      <div>{t(props.locale, "gov.channels.channelChatId")}</div>
                      <input value={channelChatId} onChange={(e) => setChannelChatId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.channelChatId.hint")} />
                    </label>
                    <label style={{ display: "grid", gap: 4 }}>
                      <div>{t(props.locale, "gov.channels.defaultSubjectId")}</div>
                      <input value={defaultSubjectId} onChange={(e) => setDefaultSubjectId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.defaultSubjectId.hint")} />
                    </label>
                    <div>
                      <button onClick={saveChatBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelChatId.trim()}>
                        {t(props.locale, "action.save")}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 600 }}>{t(props.locale, "gov.channels.accountBinding")}</div>
                    <div style={{ color: "#64748b", fontSize: 13 }}>{t(props.locale, "gov.channels.accountBinding.desc")}</div>
                    <label style={{ display: "grid", gap: 4 }}>
                      <div>{t(props.locale, "gov.channels.channelUserId")}</div>
                      <input value={channelUserId} onChange={(e) => setChannelUserId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.channelUserId.hint")} />
                    </label>
                    <label style={{ display: "grid", gap: 4 }}>
                      <div>{t(props.locale, "gov.channels.subjectId")}</div>
                      <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.subjectId.hint")} />
                    </label>
                    <div>
                      <button onClick={saveAccountBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelUserId.trim() || !subjectId.trim()}>
                        {t(props.locale, "action.save")}
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
            <div style={{ marginTop: 16 }}>
              <Card title={t(props.locale, "gov.channels.configsListTitle")}>
                <Table>
                  <thead>
                    <tr>
                      <th>{t(props.locale, "gov.channels.table.provider")}</th>
                      <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                      <th>{t(props.locale, "gov.channels.table.secretEnvKey")}</th>
                      <th>{t(props.locale, "gov.channels.table.secretId")}</th>
                      <th>{t(props.locale, "gov.channels.table.deliveryMode")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfgItems.map((c: any, idx: number) => (
                      <tr key={String(c.workspaceId ?? idx)}>
                        <td>{String(c.provider ?? "")}</td>
                        <td>{String(c.workspaceId ?? "")}</td>
                        <td>{String(c.secretEnvKey ?? "")}</td>
                        <td>{String(c.secretId ?? "")}</td>
                        <td>{String(c.deliveryMode ?? "")}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          </>
        )},
        { key: "ingress", label: t(props.locale, "gov.channels.tab.ingress"), content: (
          <Card title={t(props.locale, "gov.channels.ingressDeadletterTitle")}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <StatusBadge locale={props.locale} status={events.status} />
              <select value={ingressStatus} onChange={(e) => setIngressStatus(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                <option value="all">{t(props.locale, "gov.channels.filter.all")}</option>
                <option value="received">{t(props.locale, "gov.channels.filter.received")}</option>
                <option value="processed">{t(props.locale, "gov.channels.filter.processed")}</option>
                <option value="deadletter">{t(props.locale, "gov.channels.filter.deadletter")}</option>
              </select>
              <button onClick={refreshEvents} disabled={busy} style={{ fontSize: 13 }}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
            <Table>
              <thead>
                <tr>
                  <th>{t(props.locale, "gov.channels.table.provider")}</th>
                  <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                  <th>{t(props.locale, "gov.channels.table.eventId")}</th>
                  <th>{t(props.locale, "gov.channels.table.status")}</th>
                  <th>{t(props.locale, "gov.changesets.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {evItems.map((e: any, idx: number) => (
                  <tr key={String(e.id ?? e.eventId ?? idx)}>
                    <td>{String(e.provider ?? "")}</td>
                    <td>{String(e.workspaceId ?? "")}</td>
                    <td>{String(e.eventId ?? "")}</td>
                    <td>{String(e.status ?? "")}</td>
                    <td>
                      <button disabled={busy || !e.id} onClick={() => retryIngress(String(e.id))}>
                        {t(props.locale, "gov.channels.outbox.retry")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )},
        { key: "binding", label: t(props.locale, "gov.channels.tab.binding"), content: (
          <>
            <Card title={t(props.locale, "gov.channels.binding.title")}>
              <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 16px" }}>{t(props.locale, "gov.channels.binding.desc")}</p>
              {!bindingResult ? (
                <div style={{ textAlign: "center", padding: "24px 0" }}>
                  <button
                    onClick={initiateBinding}
                    disabled={busy || !provider.trim() || !workspaceId.trim() || !spaceId.trim()}
                    style={{ fontSize: 15, padding: "10px 32px" }}
                  >
                    {busy ? t(props.locale, "gov.channels.binding.generating") : t(props.locale, "gov.channels.binding.generate")}
                  </button>
                  {(!provider.trim() || !workspaceId.trim() || !spaceId.trim()) && (
                    <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
                      {t(props.locale, "gov.channels.binding.prerequisite")}
                    </p>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <p style={{ color: "#475569", fontSize: 13, margin: "0 0 12px" }}>{t(props.locale, "gov.channels.binding.qrHint")}</p>
                  <Image
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(bindingResult.authorizeUrl)}`}
                    alt="QR Code"
                    width={240}
                    height={240}
                    unoptimized
                    style={{ width: 240, height: 240, borderRadius: 12, border: "1px solid #e2e8f0" }}
                  />
                  <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center", alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={() => { navigator.clipboard.writeText(bindingResult.authorizeUrl); setBindingCopied(true); setTimeout(() => setBindingCopied(false), 2000); }}>
                      {bindingCopied ? t(props.locale, "gov.channels.binding.copied") : t(props.locale, "gov.channels.binding.copyLink")}
                    </button>
                    <button onClick={() => { setBindingResult(null); setBindingCopied(false); }}>
                      {t(props.locale, "gov.channels.binding.regenerate")}
                    </button>
                  </div>
                  <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 8 }}>
                    {t(props.locale, "gov.channels.binding.expiresAt")}: {bindingResult.expiresAt}
                  </p>
                </div>
              )}
            </Card>
            <div style={{ marginTop: 16 }}>
              <Card title={t(props.locale, "gov.channels.binding.historyTitle")}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <button onClick={() => refreshBindingStates()} disabled={busy} style={{ fontSize: 13 }}>
                    {t(props.locale, "action.refresh")}
                  </button>
                </div>
                {bindingStates.length === 0 ? (
                  <p style={{ color: "#94a3b8", fontSize: 13 }}>{t(props.locale, "gov.channels.binding.noHistory")}</p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <th>{t(props.locale, "gov.channels.binding.col.provider")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.workspaceId")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.spaceId")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.label")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.status")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.channelUserId")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.createdAt")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.expiresAt")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bindingStates.map((s: any, idx: number) => (
                        <tr key={String(s.id ?? idx)}>
                          <td>{String(s.provider ?? "")}</td>
                          <td>{String(s.workspaceId ?? "")}</td>
                          <td>{String(s.spaceId ?? "")}</td>
                          <td>{String(s.label ?? "")}</td>
                          <td>
                            <Badge tone={s.status === "consumed" ? "success" : s.status === "expired" ? "danger" : "warning"}>
                              {t(props.locale, `gov.channels.binding.status.${s.status}`) || String(s.status ?? "")}
                            </Badge>
                          </td>
                          <td>{String(s.boundChannelUserId ?? "")}</td>
                          <td>{String(s.createdAt ?? "")}</td>
                          <td>{String(s.expiresAt ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </div>
          </>
        )},
        { key: "outbox", label: t(props.locale, "gov.channels.tab.outbox"), content: (
          <Card title={t(props.locale, "gov.channels.outboxListTitle")}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <StatusBadge locale={props.locale} status={outbox.status} />
              <select value={outboxStatus} onChange={(e) => setOutboxStatus(e.target.value)} disabled={busy}>
                <option value="deadletter">{t(props.locale, "gov.channels.outbox.status.deadletter")}</option>
                <option value="failed">{t(props.locale, "gov.channels.outbox.status.failed")}</option>
                <option value="queued">{t(props.locale, "gov.channels.outbox.status.queued")}</option>
                <option value="processing">{t(props.locale, "gov.channels.outbox.status.processing")}</option>
                <option value="delivered">{t(props.locale, "gov.channels.outbox.status.delivered")}</option>
                <option value="acked">{t(props.locale, "gov.channels.outbox.status.acked")}</option>
                <option value="canceled">{t(props.locale, "gov.channels.outbox.status.canceled")}</option>
              </select>
              <button onClick={refreshOutbox} disabled={busy}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
            <Table header={<span>{outboxItems.length ? `${outboxItems.length}` : "-"}</span>}>
              <thead>
                <tr>
                  <th>{t(props.locale, "gov.channels.table.provider")}</th>
                  <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                  <th>{t(props.locale, "gov.channels.table.channelChatId")}</th>
                  <th>{t(props.locale, "gov.channels.table.requestId")}</th>
                  <th>{t(props.locale, "gov.channels.table.status")}</th>
                  <th>{t(props.locale, "gov.channels.table.attempt")}</th>
                  <th>{t(props.locale, "gov.channels.table.nextAttemptAt")}</th>
                  <th>{t(props.locale, "gov.channels.table.lastError")}</th>
                  <th>{t(props.locale, "gov.changesets.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {outboxItems.map((m: any, idx: number) => (
                  <tr key={String(m.id ?? idx)}>
                    <td>{String(m.provider ?? "")}</td>
                    <td>{String(m.workspaceId ?? "")}</td>
                    <td>{String(m.channelChatId ?? "")}</td>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(m.requestId ?? "")}</td>
                    <td>{String(m.status ?? "")}</td>
                    <td>{String(m.attemptCount ?? "")}</td>
                    <td>{String(m.nextAttemptAt ?? "")}</td>
                    <td>{String(m.lastErrorCategory ?? "")}{m.lastErrorDigest ? `:${String(m.lastErrorDigest)}` : ""}</td>
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button disabled={busy || !m.id} onClick={() => retryOutbox(String(m.id))}>
                          {t(props.locale, "gov.channels.outbox.retry")}
                        </button>
                        <button disabled={busy || !m.id} onClick={() => cancelOutbox(String(m.id))}>
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
      ]} />
    </div>
  );
}
