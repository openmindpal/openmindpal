"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, TabNav } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type InitialData = { status: number; json: unknown };

type FederationNode = {
  nodeId: string;
  name: string;
  endpoint: string;
  direction: "inbound_only" | "outbound_only" | "bi";
  authMethod: string;
  status: string;
  trustLevel: string;
  lastHeartbeat: string | null;
  createdAt: string;
};

type FederationStatus = {
  enabled: boolean;
  mode: string;
};

type EnvelopeLog = {
  logId: string;
  nodeId: string;
  direction: string;
  envelopeType: string;
  status: string;
  latencyMs: number | null;
  createdAt: string;
};

type PermissionType = "read" | "write" | "forward" | "audit" | "invoke" | "subscribe";

type PermissionGrant = {
  grantId: string;
  nodeId: string;
  permissionType: PermissionType;
  resourcePattern: string;
  conditions: Record<string, unknown> | null;
  expiresAt: string | null;
  grantedBy: string;
  revokedAt: string | null;
  createdAt: string;
};

type UserGrant = {
  userGrantId: string;
  nodeId: string;
  localUserId: string;
  remoteIdentity: string;
  scopes: string[];
  consentedAt: string;
  revokedAt: string | null;
  createdAt: string;
};

type ContentPolicy = {
  policyId: string;
  policyName: string;
  policyType: "usage_restriction" | "lifecycle" | "redaction" | "encryption";
  rules: Record<string, unknown>;
  appliesToNodes: string[] | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type AuditLog = {
  logId: string;
  nodeId: string;
  eventType: string;
  actorType: "user" | "node" | "system";
  actorId: string;
  targetResource: string;
  outcome: "success" | "denied" | "error";
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

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

export default function FederationClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // 联邦状态
  const [federationStatus, setFederationStatus] = useState<FederationStatus | null>(null);
  const [nodes, setNodes] = useState<FederationNode[]>([]);
  const [logs, setLogs] = useState<EnvelopeLog[]>([]);
  const [activeNodes, setActiveNodes] = useState(0);

  // 新增状态：权限授权
  const [permGrants, setPermGrants] = useState<PermissionGrant[]>([]);
  const [permNodeId, setPermNodeId] = useState("");
  const [permType, setPermType] = useState<PermissionType>("read");
  const [permResource, setPermResource] = useState("");
  const [permConditions, setPermConditions] = useState("");
  const [permExpires, setPermExpires] = useState("");

  // 新增状态：用户授权
  const [userGrants, setUserGrants] = useState<UserGrant[]>([]);
  const [ugNodeId, setUgNodeId] = useState("");
  const [ugLocalUser, setUgLocalUser] = useState("");
  const [ugRemoteId, setUgRemoteId] = useState("");
  const [ugScopes, setUgScopes] = useState("");

  // 新增状态：内容策略
  const [policies, setPolicies] = useState<ContentPolicy[]>([]);
  const [policyName, setPolicyName] = useState("");
  const [policyType, setPolicyType] = useState<ContentPolicy["policyType"]>("usage_restriction");
  const [policyRules, setPolicyRules] = useState("");
  const [policyNodes, setPolicyNodes] = useState("");
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [editingPolicy, setEditingPolicy] = useState<ContentPolicy | null>(null);

  // 新增状态：审计日志
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditFilterNode, setAuditFilterNode] = useState("");

  // 表单状态
  const [formName, setFormName] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formDirection, setFormDirection] = useState<"bi" | "inbound_only" | "outbound_only">("bi");
  const [formAuthMethod, setFormAuthMethod] = useState<"bearer" | "hmac" | "mtls" | "none">("bearer");
  const [formStatus, setFormStatus] = useState<"pending" | "active" | "suspended">("pending");
  const [formTrustLevel, setFormTrustLevel] = useState<"untrusted" | "trusted" | "verified">("untrusted");

  // 测试结果
  const [testResult, setTestResult] = useState<{ nodeId: string; ok: boolean; latencyMs: number; error?: string } | null>(null);

  // 初始化数据
  useEffect(() => {
    if (props.initial?.json) {
      const data = props.initial.json as { status?: FederationStatus; nodes?: FederationNode[]; activeNodes?: number };
      if (data.status) setFederationStatus(data.status);
      if (data.nodes) setNodes(data.nodes);
      if (data.activeNodes != null) setActiveNodes(data.activeNodes);
    }
  }, [props.initial]);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/governance/federation/status", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json) {
        setFederationStatus(json.status ?? null);
        setActiveNodes(json.activeNodes ?? 0);
      }
    } catch { /* ignore */ }
  }, [props.locale]);

  const refreshNodes = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/nodes?limit=100", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setNodes((json?.nodes as FederationNode[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  const refreshLogs = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/logs?limit=50", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setLogs((json?.logs as EnvelopeLog[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  useEffect(() => {
    refreshStatus();
    refreshNodes();
  }, [refreshStatus, refreshNodes]);

  async function createNode() {
    if (!formName.trim() || !formEndpoint.trim()) {
      setError(t(props.locale, "gov.federation.error.nameEndpointRequired"));
      return;
    }
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/nodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          name: formName.trim(),
          endpoint: formEndpoint.trim(),
          direction: formDirection,
          authMethod: formAuthMethod,
          status: formStatus,
          trustLevel: formTrustLevel,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.federation.nodeCreated"));
      setFormName("");
      setFormEndpoint("");
      await refreshNodes();
      await refreshStatus();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function updateNodeStatus(nodeId: string, status: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/nodes/${nodeId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ status }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshNodes();
      await refreshStatus();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function deleteNode(nodeId: string) {
    if (!confirm(t(props.locale, "gov.federation.confirmDelete"))) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/nodes/${nodeId}`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshNodes();
      await refreshStatus();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function testNode(nodeId: string) {
    setTestResult(null);
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/nodes/${nodeId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setTestResult({ nodeId, ok: json.ok, latencyMs: json.latencyMs, error: json.error });
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const directionLabel = (d: string) => {
    if (d === "bi") return t(props.locale, "gov.federation.direction.bi");
    if (d === "inbound_only") return t(props.locale, "gov.federation.direction.inbound");
    if (d === "outbound_only") return t(props.locale, "gov.federation.direction.outbound");
    return d;
  };

  const statusLabel = (s: string) => {
    if (s === "active") return t(props.locale, "gov.federation.status.active");
    if (s === "pending") return t(props.locale, "gov.federation.status.pending");
    if (s === "suspended") return t(props.locale, "gov.federation.status.suspended");
    if (s === "revoked") return t(props.locale, "gov.federation.status.revoked");
    return s;
  };

  const trustLabel = (tl: string) => {
    if (tl === "verified") return t(props.locale, "gov.federation.trust.verified");
    if (tl === "trusted") return t(props.locale, "gov.federation.trust.trusted");
    return t(props.locale, "gov.federation.trust.untrusted");
  };

  const permTypeLabel = (pt: PermissionType) => t(props.locale, `gov.federation.perm.type.${pt}`);
  const policyTypeLabel = (pt: string) => t(props.locale, `gov.federation.policy.type.${pt === "usage_restriction" ? "usageRestriction" : pt}`);
  const actorTypeLabel = (at: string) => t(props.locale, `gov.federation.audit.actorType.${at}`);
  const outcomeLabel = (o: string) => t(props.locale, `gov.federation.audit.outcome.${o}`);

  // ========== 新增 API 调用 ==========
  const refreshPermGrants = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/permission-grants?limit=100", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPermGrants((json?.grants as PermissionGrant[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  async function createPermGrant() {
    if (!permNodeId) {
      setError(t(props.locale, "gov.federation.perm.selectNode"));
      return;
    }
    setError("");
    setInfo("");
    setBusy(true);
    try {
      let conditions: Record<string, unknown> | null = null;
      if (permConditions.trim()) {
        conditions = JSON.parse(permConditions);
      }
      const res = await apiFetch("/governance/federation/permission-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          nodeId: permNodeId,
          permissionType: permType,
          resourcePattern: permResource || "*",
          conditions,
          expiresAt: permExpires || null,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.federation.perm.created"));
      setPermNodeId("");
      setPermResource("");
      setPermConditions("");
      setPermExpires("");
      await refreshPermGrants();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function revokePermGrant(grantId: string) {
    if (!confirm(t(props.locale, "gov.federation.perm.confirmRevoke"))) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/permission-grants/${grantId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshPermGrants();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshUserGrants = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/user-grants?limit=100", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setUserGrants((json?.grants as UserGrant[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  async function createUserGrant() {
    if (!ugNodeId || !ugLocalUser.trim() || !ugRemoteId.trim()) {
      setError(t(props.locale, "gov.federation.perm.selectNode"));
      return;
    }
    setError("");
    setInfo("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/user-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          nodeId: ugNodeId,
          localUserId: ugLocalUser.trim(),
          remoteIdentity: ugRemoteId.trim(),
          scopes: ugScopes.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.federation.userGrant.created"));
      setUgNodeId("");
      setUgLocalUser("");
      setUgRemoteId("");
      setUgScopes("");
      await refreshUserGrants();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function revokeUserGrant(userGrantId: string) {
    if (!confirm(t(props.locale, "gov.federation.userGrant.confirmRevoke"))) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/user-grants/${userGrantId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshUserGrants();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshPolicies = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch("/governance/federation/content-policies?limit=100", { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPolicies((json?.policies as ContentPolicy[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  async function createPolicy() {
    if (!policyName.trim()) {
      setError("Policy name is required");
      return;
    }
    setError("");
    setInfo("");
    setBusy(true);
    try {
      let rules: Record<string, unknown> = {};
      if (policyRules.trim()) {
        rules = JSON.parse(policyRules);
      }
      const res = await apiFetch("/governance/federation/content-policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          policyName: policyName.trim(),
          policyType,
          rules,
          appliesToNodes: policyNodes.trim() ? policyNodes.split(",").map((s) => s.trim()) : null,
          enabled: policyEnabled,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.federation.policy.created"));
      setPolicyName("");
      setPolicyRules("");
      setPolicyNodes("");
      await refreshPolicies();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function updatePolicy(policyId: string, updates: Partial<ContentPolicy>) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/content-policies/${policyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(updates),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.federation.policy.updated"));
      setEditingPolicy(null);
      await refreshPolicies();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function deletePolicy(policyId: string) {
    if (!confirm(t(props.locale, "gov.federation.policy.confirmDelete"))) return;
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/federation/content-policies/${policyId}`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshPolicies();
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshAuditLogs = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const query = auditFilterNode ? `?nodeId=${auditFilterNode}&limit=100` : "?limit=100";
      const res = await apiFetch(`/governance/federation/audit-logs${query}`, { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setAuditLogs((json?.logs as AuditLog[]) ?? []);
    } catch (e) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale, auditFilterNode]);

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.federation")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={federationStatus?.enabled ? 200 : 0} />
            <Badge>{federationStatus?.mode ?? "disabled"}</Badge>
            <Badge>{t(props.locale, "gov.federation.activeNodes")}: {activeNodes}</Badge>
            <button onClick={() => { refreshNodes(); refreshStatus(); }} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {info ? <pre style={{ color: "green", whiteSpace: "pre-wrap" }}>{info}</pre> : null}

      <TabNav tabs={[
        {
          key: "nodes",
          label: t(props.locale, "gov.federation.tab.nodes"),
          content: (
            <>
              {/* 新建节点表单 */}
              <Card title={t(props.locale, "gov.federation.createNode")}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.nodeName")}</span>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.nodeName.placeholder")}
                      style={{ padding: 8 }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.endpoint")}</span>
                    <input
                      type="text"
                      value={formEndpoint}
                      onChange={(e) => setFormEndpoint(e.target.value)}
                      placeholder="https://remote-agent.example.com/api"
                      style={{ padding: 8 }}
                    />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.direction")}</span>
                    <select value={formDirection} onChange={(e) => setFormDirection(e.target.value as "bi" | "inbound_only" | "outbound_only")} style={{ padding: 8 }}>
                      <option value="bi">{t(props.locale, "gov.federation.direction.bi")}</option>
                      <option value="inbound_only">{t(props.locale, "gov.federation.direction.inbound")}</option>
                      <option value="outbound_only">{t(props.locale, "gov.federation.direction.outbound")}</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.authMethod")}</span>
                    <select value={formAuthMethod} onChange={(e) => setFormAuthMethod(e.target.value as "bearer" | "hmac" | "mtls" | "none")} style={{ padding: 8 }}>
                      <option value="bearer">Bearer Token</option>
                      <option value="hmac">HMAC</option>
                      <option value="mtls">mTLS</option>
                      <option value="none">{t(props.locale, "gov.federation.authMethod.none")}</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.status")}</span>
                    <select value={formStatus} onChange={(e) => setFormStatus(e.target.value as "pending" | "active" | "suspended")} style={{ padding: 8 }}>
                      <option value="pending">{t(props.locale, "gov.federation.status.pending")}</option>
                      <option value="active">{t(props.locale, "gov.federation.status.active")}</option>
                      <option value="suspended">{t(props.locale, "gov.federation.status.suspended")}</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.trustLevel")}</span>
                    <select value={formTrustLevel} onChange={(e) => setFormTrustLevel(e.target.value as "untrusted" | "trusted" | "verified")} style={{ padding: 8 }}>
                      <option value="untrusted">{t(props.locale, "gov.federation.trust.untrusted")}</option>
                      <option value="trusted">{t(props.locale, "gov.federation.trust.trusted")}</option>
                      <option value="verified">{t(props.locale, "gov.federation.trust.verified")}</option>
                    </select>
                  </label>
                </div>
                <div style={{ marginTop: 16 }}>
                  <button onClick={createNode} disabled={busy}>
                    {t(props.locale, "gov.federation.createBtn")}
                  </button>
                </div>
              </Card>

              {/* 节点列表 */}
              <Card title={t(props.locale, "gov.federation.nodeList")}>
                {nodes.length === 0 ? (
                  <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.noNodes")}</p>
                ) : (
                  <Table header={<span>{t(props.locale, "gov.federation.nodeList")} <Badge>{nodes.length}</Badge></span>}>
                    <thead>
                      <tr>
                        <th align="left">{t(props.locale, "gov.federation.nodeName")}</th>
                        <th align="left">{t(props.locale, "gov.federation.endpoint")}</th>
                        <th align="left">{t(props.locale, "gov.federation.direction")}</th>
                        <th align="left">{t(props.locale, "gov.federation.status")}</th>
                        <th align="left">{t(props.locale, "gov.federation.trustLevel")}</th>
                        <th align="left">{t(props.locale, "gov.federation.lastHeartbeat")}</th>
                        <th align="left">{t(props.locale, "gov.federation.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nodes.map((n) => (
                        <tr key={n.nodeId}>
                          <td>{n.name}</td>
                          <td style={{ fontSize: 12, wordBreak: "break-all", maxWidth: 200 }}>{n.endpoint}</td>
                          <td>{directionLabel(n.direction)}</td>
                          <td><Badge>{statusLabel(n.status)}</Badge></td>
                          <td><Badge>{trustLabel(n.trustLevel)}</Badge></td>
                          <td>{n.lastHeartbeat ? new Date(n.lastHeartbeat).toLocaleString() : "-"}</td>
                          <td>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => testNode(n.nodeId)} disabled={busy}>
                                {t(props.locale, "gov.federation.test")}
                              </button>
                              {n.status !== "active" && (
                                <button onClick={() => updateNodeStatus(n.nodeId, "active")} disabled={busy}>
                                  {t(props.locale, "gov.federation.activate")}
                                </button>
                              )}
                              {n.status === "active" && (
                                <button onClick={() => updateNodeStatus(n.nodeId, "suspended")} disabled={busy}>
                                  {t(props.locale, "gov.federation.suspend")}
                                </button>
                              )}
                              <button onClick={() => deleteNode(n.nodeId)} disabled={busy} style={{ color: "#c00" }}>
                                {t(props.locale, "gov.federation.delete")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>

              {/* 测试结果 */}
              {testResult && (
                <Card title={t(props.locale, "gov.federation.testResult")}>
                  <p style={{ color: testResult.ok ? "green" : "crimson" }}>
                    {testResult.ok
                      ? `${t(props.locale, "gov.federation.testSuccess")} (${testResult.latencyMs}ms)`
                      : `${t(props.locale, "gov.federation.testFailed")}: ${testResult.error}`}
                  </p>
                </Card>
              )}
            </>
          ),
        },
        {
          key: "logs",
          label: t(props.locale, "gov.federation.tab.logs"),
          content: (
            <Card title={t(props.locale, "gov.federation.communicationLogs")}>
              <button onClick={refreshLogs} disabled={busy} style={{ marginBottom: 12 }}>
                {t(props.locale, "action.refresh")}
              </button>
              {logs.length === 0 ? (
                <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.noLogs")}</p>
              ) : (
                <Table header={<span>{t(props.locale, "gov.federation.communicationLogs")} <Badge>{logs.length}</Badge></span>}>
                  <thead>
                    <tr>
                      <th align="left">{t(props.locale, "gov.federation.log.time")}</th>
                      <th align="left">{t(props.locale, "gov.federation.log.direction")}</th>
                      <th align="left">{t(props.locale, "gov.federation.log.type")}</th>
                      <th align="left">{t(props.locale, "gov.federation.status")}</th>
                      <th align="left">{t(props.locale, "gov.federation.log.latency")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.logId}>
                        <td>{new Date(log.createdAt).toLocaleString()}</td>
                        <td>{log.direction === "inbound" ? t(props.locale, "gov.federation.log.inbound") : t(props.locale, "gov.federation.log.outbound")}</td>
                        <td>{log.envelopeType}</td>
                        <td><Badge>{log.status}</Badge></td>
                        <td>{log.latencyMs != null ? `${log.latencyMs}ms` : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          ),
        },
        {
          key: "permissions",
          label: t(props.locale, "gov.federation.tab.permissions"),
          content: (
            <>
              <Card title={t(props.locale, "gov.federation.perm.create")}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.nodeId")}</span>
                    <select value={permNodeId} onChange={(e) => setPermNodeId(e.target.value)} style={{ padding: 8 }}>
                      <option value="">{t(props.locale, "gov.federation.perm.selectNode")}</option>
                      {nodes.map((n) => <option key={n.nodeId} value={n.nodeId}>{n.name}</option>)}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.permissionType")}</span>
                    <select value={permType} onChange={(e) => setPermType(e.target.value as PermissionType)} style={{ padding: 8 }}>
                      {(["read", "write", "forward", "audit", "invoke", "subscribe"] as PermissionType[]).map((pt) => (
                        <option key={pt} value={pt}>{permTypeLabel(pt)}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.resourcePattern")}</span>
                    <input type="text" value={permResource} onChange={(e) => setPermResource(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.perm.resourcePattern.placeholder")} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.conditions")}</span>
                    <input type="text" value={permConditions} onChange={(e) => setPermConditions(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.perm.conditions.placeholder")} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.expiresAt")}</span>
                    <input type="datetime-local" value={permExpires} onChange={(e) => setPermExpires(e.target.value)} style={{ padding: 8 }} />
                  </label>
                </div>
                <div style={{ marginTop: 16 }}>
                  <button onClick={createPermGrant} disabled={busy}>{t(props.locale, "gov.federation.perm.create")}</button>
                </div>
              </Card>
              <Card title={t(props.locale, "gov.federation.perm.title")}>
                <button onClick={refreshPermGrants} disabled={busy} style={{ marginBottom: 12 }}>{t(props.locale, "action.refresh")}</button>
                {permGrants.length === 0 ? (
                  <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.perm.noGrants")}</p>
                ) : (
                  <Table header={<span>{t(props.locale, "gov.federation.perm.title")} <Badge>{permGrants.length}</Badge></span>}>
                    <thead>
                      <tr>
                        <th align="left">{t(props.locale, "gov.federation.perm.nodeId")}</th>
                        <th align="left">{t(props.locale, "gov.federation.perm.permissionType")}</th>
                        <th align="left">{t(props.locale, "gov.federation.perm.resourcePattern")}</th>
                        <th align="left">{t(props.locale, "gov.federation.perm.expiresAt")}</th>
                        <th align="left">{t(props.locale, "gov.federation.perm.grantedAt")}</th>
                        <th align="left">{t(props.locale, "gov.federation.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permGrants.map((g) => (
                        <tr key={g.grantId}>
                          <td>{nodes.find((n) => n.nodeId === g.nodeId)?.name ?? g.nodeId}</td>
                          <td><Badge>{permTypeLabel(g.permissionType)}</Badge></td>
                          <td style={{ fontSize: 12 }}>{g.resourcePattern}</td>
                          <td>{g.expiresAt ? new Date(g.expiresAt).toLocaleString() : "-"}</td>
                          <td>{new Date(g.createdAt).toLocaleString()}</td>
                          <td>
                            {g.revokedAt ? (
                              <Badge>{t(props.locale, "gov.federation.perm.revoked")}</Badge>
                            ) : (
                              <button onClick={() => revokePermGrant(g.grantId)} disabled={busy} style={{ color: "#c00" }}>
                                {t(props.locale, "gov.federation.perm.revoke")}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          ),
        },
        {
          key: "userGrants",
          label: t(props.locale, "gov.federation.tab.userGrants"),
          content: (
            <>
              <Card title={t(props.locale, "gov.federation.userGrant.create")}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.perm.nodeId")}</span>
                    <select value={ugNodeId} onChange={(e) => setUgNodeId(e.target.value)} style={{ padding: 8 }}>
                      <option value="">{t(props.locale, "gov.federation.perm.selectNode")}</option>
                      {nodes.map((n) => <option key={n.nodeId} value={n.nodeId}>{n.name}</option>)}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.userGrant.localUserId")}</span>
                    <input type="text" value={ugLocalUser} onChange={(e) => setUgLocalUser(e.target.value)} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.userGrant.remoteIdentity")}</span>
                    <input type="text" value={ugRemoteId} onChange={(e) => setUgRemoteId(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.userGrant.remoteIdentity.placeholder")} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.userGrant.scopes")}</span>
                    <input type="text" value={ugScopes} onChange={(e) => setUgScopes(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.userGrant.scopes.placeholder")} style={{ padding: 8 }} />
                  </label>
                </div>
                <div style={{ marginTop: 16 }}>
                  <button onClick={createUserGrant} disabled={busy}>{t(props.locale, "gov.federation.userGrant.create")}</button>
                </div>
              </Card>
              <Card title={t(props.locale, "gov.federation.userGrant.title")}>
                <button onClick={refreshUserGrants} disabled={busy} style={{ marginBottom: 12 }}>{t(props.locale, "action.refresh")}</button>
                {userGrants.length === 0 ? (
                  <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.userGrant.noGrants")}</p>
                ) : (
                  <Table header={<span>{t(props.locale, "gov.federation.userGrant.title")} <Badge>{userGrants.length}</Badge></span>}>
                    <thead>
                      <tr>
                        <th align="left">{t(props.locale, "gov.federation.perm.nodeId")}</th>
                        <th align="left">{t(props.locale, "gov.federation.userGrant.localUserId")}</th>
                        <th align="left">{t(props.locale, "gov.federation.userGrant.remoteIdentity")}</th>
                        <th align="left">{t(props.locale, "gov.federation.userGrant.scopes")}</th>
                        <th align="left">{t(props.locale, "gov.federation.userGrant.consentedAt")}</th>
                        <th align="left">{t(props.locale, "gov.federation.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userGrants.map((g) => (
                        <tr key={g.userGrantId}>
                          <td>{nodes.find((n) => n.nodeId === g.nodeId)?.name ?? g.nodeId}</td>
                          <td>{g.localUserId}</td>
                          <td>{g.remoteIdentity}</td>
                          <td>{g.scopes.join(", ")}</td>
                          <td>{new Date(g.consentedAt).toLocaleString()}</td>
                          <td>
                            {g.revokedAt ? (
                              <Badge>{t(props.locale, "gov.federation.perm.revoked")}</Badge>
                            ) : (
                              <button onClick={() => revokeUserGrant(g.userGrantId)} disabled={busy} style={{ color: "#c00" }}>
                                {t(props.locale, "gov.federation.perm.revoke")}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          ),
        },
        {
          key: "policies",
          label: t(props.locale, "gov.federation.tab.policies"),
          content: (
            <>
              <Card title={t(props.locale, "gov.federation.policy.create")}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.policy.policyName")}</span>
                    <input type="text" value={policyName} onChange={(e) => setPolicyName(e.target.value)} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.policy.policyType")}</span>
                    <select value={policyType} onChange={(e) => setPolicyType(e.target.value as ContentPolicy["policyType"])} style={{ padding: 8 }}>
                      <option value="usage_restriction">{t(props.locale, "gov.federation.policy.type.usageRestriction")}</option>
                      <option value="lifecycle">{t(props.locale, "gov.federation.policy.type.lifecycle")}</option>
                      <option value="redaction">{t(props.locale, "gov.federation.policy.type.redaction")}</option>
                      <option value="encryption">{t(props.locale, "gov.federation.policy.type.encryption")}</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.policy.rules")}</span>
                    <input type="text" value={policyRules} onChange={(e) => setPolicyRules(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.policy.rules.placeholder")} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span>{t(props.locale, "gov.federation.policy.appliesToNodes")}</span>
                    <input type="text" value={policyNodes} onChange={(e) => setPolicyNodes(e.target.value)}
                      placeholder={t(props.locale, "gov.federation.policy.appliesToNodes.all")} style={{ padding: 8 }} />
                  </label>
                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={policyEnabled} onChange={(e) => setPolicyEnabled(e.target.checked)} />
                    <span>{t(props.locale, "gov.federation.policy.enabled")}</span>
                  </label>
                </div>
                <div style={{ marginTop: 16 }}>
                  <button onClick={createPolicy} disabled={busy}>{t(props.locale, "gov.federation.policy.create")}</button>
                </div>
              </Card>
              <Card title={t(props.locale, "gov.federation.policy.title")}>
                <button onClick={refreshPolicies} disabled={busy} style={{ marginBottom: 12 }}>{t(props.locale, "action.refresh")}</button>
                {policies.length === 0 ? (
                  <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.policy.noPolicies")}</p>
                ) : (
                  <Table header={<span>{t(props.locale, "gov.federation.policy.title")} <Badge>{policies.length}</Badge></span>}>
                    <thead>
                      <tr>
                        <th align="left">{t(props.locale, "gov.federation.policy.policyName")}</th>
                        <th align="left">{t(props.locale, "gov.federation.policy.policyType")}</th>
                        <th align="left">{t(props.locale, "gov.federation.policy.appliesToNodes")}</th>
                        <th align="left">{t(props.locale, "gov.federation.status")}</th>
                        <th align="left">{t(props.locale, "gov.federation.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policies.map((p) => (
                        <tr key={p.policyId}>
                          <td>{p.policyName}</td>
                          <td><Badge>{policyTypeLabel(p.policyType)}</Badge></td>
                          <td>{p.appliesToNodes?.join(", ") || t(props.locale, "gov.federation.policy.appliesToNodes.all")}</td>
                          <td><Badge>{p.enabled ? t(props.locale, "gov.federation.policy.enabled") : t(props.locale, "gov.federation.policy.disabled")}</Badge></td>
                          <td>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => updatePolicy(p.policyId, { enabled: !p.enabled })} disabled={busy}>
                                {p.enabled ? t(props.locale, "gov.federation.policy.disabled") : t(props.locale, "gov.federation.policy.enabled")}
                              </button>
                              <button onClick={() => deletePolicy(p.policyId)} disabled={busy} style={{ color: "#c00" }}>
                                {t(props.locale, "gov.federation.delete")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          ),
        },
        {
          key: "audit",
          label: t(props.locale, "gov.federation.tab.audit"),
          content: (
            <Card title={t(props.locale, "gov.federation.audit.title")}>
              <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{t(props.locale, "gov.federation.audit.filter.nodeId")}</span>
                  <select value={auditFilterNode} onChange={(e) => setAuditFilterNode(e.target.value)} style={{ padding: 8 }}>
                    <option value="">{t(props.locale, "gov.federation.audit.filter.all")}</option>
                    {nodes.map((n) => <option key={n.nodeId} value={n.nodeId}>{n.name}</option>)}
                  </select>
                </label>
                <button onClick={refreshAuditLogs} disabled={busy}>{t(props.locale, "action.refresh")}</button>
              </div>
              {auditLogs.length === 0 ? (
                <p style={{ color: "#888" }}>{t(props.locale, "gov.federation.audit.noLogs")}</p>
              ) : (
                <Table header={<span>{t(props.locale, "gov.federation.audit.title")} <Badge>{auditLogs.length}</Badge></span>}>
                  <thead>
                    <tr>
                      <th align="left">{t(props.locale, "gov.federation.audit.timestamp")}</th>
                      <th align="left">{t(props.locale, "gov.federation.audit.eventType")}</th>
                      <th align="left">{t(props.locale, "gov.federation.audit.actorType")}</th>
                      <th align="left">{t(props.locale, "gov.federation.audit.actorId")}</th>
                      <th align="left">{t(props.locale, "gov.federation.audit.targetResource")}</th>
                      <th align="left">{t(props.locale, "gov.federation.audit.outcome")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.logId}>
                        <td>{new Date(log.createdAt).toLocaleString()}</td>
                        <td>{log.eventType}</td>
                        <td><Badge>{actorTypeLabel(log.actorType)}</Badge></td>
                        <td style={{ fontSize: 12 }}>{log.actorId}</td>
                        <td style={{ fontSize: 12, wordBreak: "break-all", maxWidth: 200 }}>{log.targetResource}</td>
                        <td><Badge tone={log.outcome === "success" ? "success" : log.outcome === "denied" ? "warning" : "danger"}>{outcomeLabel(log.outcome)}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          ),
        },
      ]} />
    </div>
  );
}
