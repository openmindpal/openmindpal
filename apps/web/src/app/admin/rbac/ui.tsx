"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader, Card, TabNav, Table } from "@/components/ui";

type ApiErr = { errorCode?: string; message?: unknown; traceId?: string };
type RoleItem = { id: string; name?: string };
type PermissionItem = { id?: string; resource_type?: string; action?: string };
type RolesList = ApiErr & { items?: RoleItem[] };
type PermissionsList = ApiErr & { items?: PermissionItem[] };

function errText(locale: string, e: ApiErr | null) {
  if (!e) return "";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  return msg || t(locale, "admin.rbac.error.loadFailed");
}

function toApiErr(e: unknown): ApiErr {
  if (e && typeof e === "object") return e as ApiErr;
  return { errorCode: "ERROR", message: String(e) };
}

export default function AdminRbacClient(props: {
  locale: string;
  initial: { roles: unknown; permissions: unknown; rolesStatus: number; permissionsStatus: number };
}) {
  const [roles, setRoles] = useState<RolesList | null>((props.initial.roles as RolesList) ?? null);
  const [permissions, setPermissions] = useState<PermissionsList | null>((props.initial.permissions as PermissionsList) ?? null);
  const [rolesStatus, setRolesStatus] = useState<number>(props.initial.rolesStatus);
  const [permissionsStatus, setPermissionsStatus] = useState<number>(props.initial.permissionsStatus);

  const [roleName, setRoleName] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [roleDetail, setRoleDetail] = useState<unknown>(null);

  const [permFilterResource, setPermFilterResource] = useState("");
  const [permFilterAction, setPermFilterAction] = useState("");
  const [grantResourceType, setGrantResourceType] = useState("entity");
  const [grantAction, setGrantAction] = useState("read");
  const [grantRowFiltersReadJson, setGrantRowFiltersReadJson] = useState<string>("");
  const [grantRowFiltersWriteJson, setGrantRowFiltersWriteJson] = useState<string>("");
  const [grantFieldRulesReadJson, setGrantFieldRulesReadJson] = useState<string>("");
  const [grantFieldRulesWriteJson, setGrantFieldRulesWriteJson] = useState<string>("");
  const [policyPreflight, setPolicyPreflight] = useState<unknown>(null);

  /* ABAC state */
  const [abacPolicies, setAbacPolicies] = useState<any[]>([]);
  const [abacName, setAbacName] = useState("");
  const [abacResource, setAbacResource] = useState("*");
  const [abacAction, setAbacAction] = useState("*");
  const [abacEffect, setAbacEffect] = useState<"deny" | "allow">("deny");
  const [abacConditions, setAbacConditions] = useState<string>("[]");
  const [abacEvalResult, setAbacEvalResult] = useState<unknown>(null);

  const [bindSubjectId, setBindSubjectId] = useState("");
  const [bindScopeType, setBindScopeType] = useState<"tenant" | "space">("space");
  const [bindScopeId, setBindScopeId] = useState("space_dev");
  const [createdBindings, setCreatedBindings] = useState<string[]>([]);

  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (rolesStatus >= 400) return errText(props.locale, roles);
    if (permissionsStatus >= 400) return errText(props.locale, permissions);
    return "";
  }, [permissions, permissionsStatus, props.locale, roles, rolesStatus]);

  const roleItems = useMemo(() => (Array.isArray(roles?.items) ? roles.items : []), [roles]);
  const permissionItems = useMemo(() => (Array.isArray(permissions?.items) ? permissions.items : []), [permissions]);

  const filteredPermissions = useMemo(() => {
    const r = permFilterResource.trim();
    const a = permFilterAction.trim();
    return permissionItems.filter((p: PermissionItem) => {
      if (r && !String(p.resource_type ?? "").includes(r)) return false;
      if (a && !String(p.action ?? "").includes(a)) return false;
      return true;
    });
  }, [permissionItems, permFilterResource, permFilterAction]);

  async function refreshRoles() {
    const res = await apiFetch(`/rbac/roles?limit=200`, { locale: props.locale, cache: "no-store" });
    setRolesStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setRoles((json as RolesList) ?? null);
    if (!res.ok) throw toApiErr(json);
  }

  async function refreshPermissions() {
    const res = await apiFetch(`/rbac/permissions?limit=500`, { locale: props.locale, cache: "no-store" });
    setPermissionsStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setPermissions((json as PermissionsList) ?? null);
    if (!res.ok) throw toApiErr(json);
  }

  async function loadRoleDetail(roleId: string) {
    const res = await apiFetch(`/rbac/roles/${encodeURIComponent(roleId)}`, { locale: props.locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toApiErr(json);
    const obj = json && typeof json === "object" ? (json as { role?: unknown }) : {};
    setRoleDetail(obj.role ?? null);
  }

  async function createRole() {
    setError("");
    try {
      const res = await apiFetch(`/rbac/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: roleName }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setRoleName("");
      await refreshRoles();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function grantPermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      let rowFiltersRead: unknown = undefined;
      let rowFiltersWrite: unknown = undefined;
      let fieldRulesRead: unknown = undefined;
      let fieldRulesWrite: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFiltersRead = JSON.parse(grantRowFiltersReadJson);
      if (grantRowFiltersWriteJson.trim()) rowFiltersWrite = JSON.parse(grantRowFiltersWriteJson);
      if (grantFieldRulesReadJson.trim()) fieldRulesRead = JSON.parse(grantFieldRulesReadJson);
      if (grantFieldRulesWriteJson.trim()) fieldRulesWrite = JSON.parse(grantFieldRulesWriteJson);
      const res = await apiFetch(`/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction, rowFiltersRead, rowFiltersWrite, fieldRulesRead, fieldRulesWrite }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      await refreshPermissions();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function preflightPolicy() {
    setError("");
    setPolicyPreflight(null);
    try {
      let rowFilters: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFilters = JSON.parse(grantRowFiltersReadJson);
      const res = await apiFetch(`/rbac/policy/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ rowFilters }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setPolicyPreflight(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function revokePermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await apiFetch(`/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      await refreshPermissions();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function createBinding() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await apiFetch(`/rbac/bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ subjectId: bindSubjectId, roleId: selectedRoleId, scopeType: bindScopeType, scopeId: bindScopeId }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      const obj = json && typeof json === "object" ? (json as { bindingId?: unknown }) : {};
      const id = String(obj.bindingId ?? "");
      if (id) setCreatedBindings((s) => [id, ...s]);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function deleteBinding(bindingId: string) {
    setError("");
    try {
      const res = await apiFetch(`/rbac/bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setCreatedBindings((s) => s.filter((x) => x !== bindingId));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function refreshAbacPolicies() {
    try {
      const res = await apiFetch(`/rbac/abac/policies`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      const items = (json as any)?.items;
      setAbacPolicies(Array.isArray(items) ? items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  const [showAdvanced, setShowAdvanced] = useState(false);

  const locale = props.locale;

  /* ─── Tab 1: Roles ─── */
  const rolesTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.roles.desc")}</p>
      <Card title={t(locale, "admin.rbac.create")}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder={t(locale, "admin.rbac.roleNamePlaceholder")}
            style={{ flex: 1, maxWidth: 320, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
          />
          <button onClick={createRole} disabled={!roleName.trim()} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
            {t(locale, "admin.rbac.create")}
          </button>
          <button onClick={refreshRoles} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
            {t(locale, "admin.rbac.refresh")}
          </button>
        </div>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16 }}>
        <Card title={t(locale, "admin.rbac.list")}>
          {roleItems.length === 0 ? (
            <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.noRoles")}</p>
          ) : (
            <ul style={{ paddingLeft: 18, margin: 0, display: "grid", gap: 4 }}>
              {roleItems.map((r: RoleItem) => (
                <li key={String(r.id)}>
                  <button
                    style={{
                      background: selectedRoleId === String(r.id) ? "var(--sl-accent-bg)" : "none",
                      border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 4, fontWeight: selectedRoleId === String(r.id) ? 600 : 400,
                      color: selectedRoleId === String(r.id) ? "var(--sl-accent)" : "var(--sl-fg)",
                    }}
                    onClick={async () => {
                      setSelectedRoleId(String(r.id));
                      setRoleDetail(null);
                      try { await loadRoleDetail(String(r.id)); } catch (e: unknown) { setError(errText(locale, toApiErr(e))); }
                    }}
                  >
                    {String(r.name ?? r.id)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t(locale, "admin.rbac.detail")}>
          {roleDetail ? (
            <pre style={{ background: "rgba(15,23,42,0.03)", padding: 12, borderRadius: 6, overflowX: "auto", margin: 0, fontSize: 12 }}>
              {JSON.stringify(roleDetail, null, 2)}
            </pre>
          ) : (
            <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.roles.desc")}</p>
          )}
        </Card>
      </div>
    </div>
  );

  /* ─── Tab 2: Permissions ─── */
  const permissionsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.permissions.desc")}</p>
      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>{t(locale, "admin.rbac.resourceTypeLabel")}:</span>
          <input value={permFilterResource} onChange={(e) => setPermFilterResource(e.target.value)} style={{ width: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          <span style={{ fontSize: 13 }}>{t(locale, "admin.rbac.actionLabel")}:</span>
          <input value={permFilterAction} onChange={(e) => setPermFilterAction(e.target.value)} style={{ width: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          <button onClick={refreshPermissions} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
            {t(locale, "admin.rbac.refresh")}
          </button>
        </div>
        {filteredPermissions.length === 0 ? (
          <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.noPermissions")}</p>
        ) : (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            <Table>
              <thead>
                <tr>
                  <th>{t(locale, "admin.rbac.table.id")}</th>
                  <th>{t(locale, "admin.rbac.table.resourceType")}</th>
                  <th>{t(locale, "admin.rbac.table.action")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredPermissions.map((p: PermissionItem) => (
                  <tr key={String(p.id)}>
                    <td>{String(p.id)}</td>
                    <td>{String(p.resource_type)}</td>
                    <td>{String(p.action)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );

  /* ─── Tab 3: Assign ─── */
  const assignTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.assign.desc")}</p>
      <Card title={t(locale, "admin.rbac.grantRevokeTitle")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.roleId")}</span>
            <select
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="">{t(locale, "rbac.selectRole")}</option>
              {roleItems.map((r: RoleItem) => (
                <option key={String(r.id)} value={String(r.id)}>{String(r.name ?? r.id)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.resourceType")}</span>
            <input value={grantResourceType} onChange={(e) => setGrantResourceType(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.action")}</span>
            <input value={grantAction} onChange={(e) => setGrantAction(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={grantPermission} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
              {t(locale, "admin.rbac.action.grant")}
            </button>
            <button onClick={revokePermission} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
              {t(locale, "admin.rbac.action.revoke")}
            </button>
            <button onClick={preflightPolicy} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
              {t(locale, "admin.rbac.action.preflight")}
            </button>
          </div>
        </div>

        {policyPreflight ? (
          <pre style={{ marginTop: 16, background: "rgba(15,23,42,0.03)", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 12 }}>
            {JSON.stringify(policyPreflight, null, 2)}
          </pre>
        ) : null}

        {/* Advanced section - collapsed by default */}
        <div style={{ marginTop: 20, borderTop: "1px solid var(--sl-border)", paddingTop: 12 }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--sl-muted)", display: "flex", alignItems: "center", gap: 4, padding: 0 }}
          >
            <span style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s", display: "inline-block" }}>▶</span>
            {t(locale, "admin.rbac.template.advancedTip")}
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 12, display: "grid", gap: 12, maxWidth: 520 }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sl-muted)" }}>{t(locale, "admin.rbac.template.quickFill")}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {[
                    { label: t(locale, "admin.rbac.template.ownerOnly"), fn: () => { setGrantRowFiltersReadJson(JSON.stringify({ kind: "owner_only" }, null, 2)); setGrantRowFiltersWriteJson(""); } },
                    { label: t(locale, "admin.rbac.template.exprOwner"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "expr", expr: { op: "eq", left: { kind: "record", key: "ownerSubjectId" }, right: { kind: "subject", key: "subjectId" } } }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.spaceMember"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "space_member", roles: ["editor", "viewer"] }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.orgHierarchy"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "org_hierarchy", orgField: "orgUnitId", includeDescendants: true }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.andComposite"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "and", rules: [{ kind: "owner_only" }, { kind: "space_member" }] }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.notNegate"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "not", rule: { kind: "payload_field_eq_literal", field: "status", value: "archived" } }, null, 2)) },
                  ].map((tpl) => (
                    <button key={tpl.label} onClick={tpl.fn} style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}>
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </div>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.rowFiltersReadJson")}</span>
                <textarea value={grantRowFiltersReadJson} onChange={(e) => setGrantRowFiltersReadJson(e.target.value)} rows={5} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)" }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.rowFiltersWriteJson")}</span>
                <textarea value={grantRowFiltersWriteJson} onChange={(e) => setGrantRowFiltersWriteJson(e.target.value)} rows={3} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)" }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.fieldRulesReadJson")}</span>
                <textarea value={grantFieldRulesReadJson} onChange={(e) => setGrantFieldRulesReadJson(e.target.value)} rows={2} placeholder={t(locale, "admin.rbac.fieldRulesHint")} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)" }} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.fieldRulesWriteJson")}</span>
                <textarea value={grantFieldRulesWriteJson} onChange={(e) => setGrantFieldRulesWriteJson(e.target.value)} rows={2} placeholder={t(locale, "admin.rbac.fieldRulesHint")} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)" }} />
              </label>
            </div>
          )}
        </div>
      </Card>
    </div>
  );

  /* ─── Tab 4: Bindings ─── */
  const bindingsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.bindings.desc")}</p>
      <Card title={t(locale, "admin.rbac.bindingsTitle")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.subjectId")}</span>
            <input value={bindSubjectId} onChange={(e) => setBindSubjectId(e.target.value)} placeholder={t(locale, "admin.rbac.subjectIdPlaceholder")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.roleId")}</span>
            <select
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="">{t(locale, "rbac.selectRole")}</option>
              {roleItems.map((r: RoleItem) => (
                <option key={String(r.id)} value={String(r.id)}>{String(r.name ?? r.id)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeType")}</span>
            <select
              value={bindScopeType}
              onChange={(e) => setBindScopeType(e.target.value === "tenant" ? "tenant" : "space")}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="tenant">{t(locale, "admin.rbac.scopeType.tenant")}</option>
              <option value="space">{t(locale, "admin.rbac.scopeType.space")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeId")}</span>
            <input value={bindScopeId} onChange={(e) => setBindScopeId(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <button
            onClick={createBinding}
            disabled={!bindSubjectId.trim() || !selectedRoleId.trim()}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, justifySelf: "start" }}
          >
            {t(locale, "admin.rbac.action.createBinding")}
          </button>
        </div>

        {createdBindings.length > 0 && (
          <div style={{ marginTop: 20, borderTop: "1px solid var(--sl-border)", paddingTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>{t(locale, "admin.rbac.createdBindingIds")}</div>
            <ul style={{ paddingLeft: 18, margin: 0, display: "grid", gap: 4 }}>
              {createdBindings.map((id) => (
                <li key={id} style={{ fontSize: 13 }}>
                  <code>{id}</code>
                  <button style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12, color: "#dc2626" }} onClick={() => deleteBinding(id)}>
                    {t(locale, "admin.rbac.action.delete")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );

  /* ─── Tab 5: ABAC Policies ─── */
  const policiesTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.policies.desc")}</p>
      <Card title={t(locale, "admin.rbac.abacTitle")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.policyName")}</span>
            <input value={abacName} onChange={(e) => setAbacName(e.target.value)} placeholder={t(locale, "admin.rbac.abac.policyName")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.resourceType")}</span>
              <input value={abacResource} onChange={(e) => setAbacResource(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
            </label>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.action")}</span>
              <input value={abacAction} onChange={(e) => setAbacAction(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.effect")}</span>
            <select value={abacEffect} onChange={(e) => setAbacEffect(e.target.value as "deny" | "allow")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
              <option value="deny">{t(locale, "admin.rbac.abac.effectDeny")}</option>
              <option value="allow">{t(locale, "admin.rbac.abac.effectAllow")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.conditions")}</span>
            <textarea
              value={abacConditions}
              onChange={(e) => setAbacConditions(e.target.value)}
              rows={4}
              placeholder='[{"type":"time_window","afterHour":9,"beforeHour":18}]'
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12, padding: 8, borderRadius: 6, border: "1px solid var(--sl-border)" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              disabled={!abacName.trim()}
              onClick={async () => {
                setError("");
                try {
                  let conds: unknown = [];
                  if (abacConditions.trim()) conds = JSON.parse(abacConditions);
                  const res = await apiFetch(`/rbac/abac/policies`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    locale,
                    body: JSON.stringify({ policyName: abacName, resourceType: abacResource, action: abacAction, effect: abacEffect, conditions: conds }),
                  });
                  const json: unknown = await res.json().catch(() => null);
                  if (!res.ok) throw toApiErr(json);
                  setAbacName("");
                  await refreshAbacPolicies();
                } catch (e: unknown) {
                  setError(errText(locale, toApiErr(e)));
                }
              }}
              style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
            >
              {t(locale, "admin.rbac.abac.create")}
            </button>
            <button onClick={refreshAbacPolicies} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
              {t(locale, "admin.rbac.abac.refresh")}
            </button>
            <button
              onClick={async () => {
                setError("");
                setAbacEvalResult(null);
                try {
                  let conds: unknown = [];
                  if (abacConditions.trim()) conds = JSON.parse(abacConditions);
                  const res = await apiFetch(`/rbac/abac/evaluate`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    locale,
                    body: JSON.stringify({ conditions: conds }),
                  });
                  const json: unknown = await res.json().catch(() => null);
                  if (!res.ok) throw toApiErr(json);
                  setAbacEvalResult(json);
                } catch (e: unknown) {
                  setError(errText(locale, toApiErr(e)));
                }
              }}
              style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}
            >
              {t(locale, "admin.rbac.abac.evaluate")}
            </button>
          </div>
        </div>
        {abacEvalResult ? (
          <pre style={{ marginTop: 16, background: "rgba(15,23,42,0.03)", padding: 12, borderRadius: 6, overflowX: "auto", fontSize: 12 }}>
            {JSON.stringify(abacEvalResult, null, 2)}
          </pre>
        ) : null}
      </Card>

      {abacPolicies.length > 0 && (
        <Card>
          <Table>
            <thead>
              <tr>
                <th>{t(locale, "admin.rbac.abac.policyName")}</th>
                <th>{t(locale, "admin.rbac.abac.resourceType")}</th>
                <th>{t(locale, "admin.rbac.abac.action")}</th>
                <th>{t(locale, "admin.rbac.abac.effect")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {abacPolicies.map((p: any) => (
                <tr key={String(p.policy_id)}>
                  <td>{String(p.policy_name)}</td>
                  <td>{String(p.resource_type)}</td>
                  <td>{String(p.action)}</td>
                  <td>{String(p.effect)}</td>
                  <td>
                    <button
                      style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12, color: "#dc2626" }}
                      onClick={async () => {
                        setError("");
                        try {
                          const res = await apiFetch(`/rbac/abac/policies/${encodeURIComponent(p.policy_id)}`, { method: "DELETE", locale });
                          const json: unknown = await res.json().catch(() => null);
                          if (!res.ok) throw toApiErr(json);
                          await refreshAbacPolicies();
                        } catch (e: unknown) {
                          setError(errText(locale, toApiErr(e)));
                        }
                      }}
                    >
                      {t(locale, "admin.rbac.abac.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader title={t(locale, "admin.rbac.title")} description={t(locale, "admin.rbac.desc")} />

      {(error || initialError) ? (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13 }}>
          {error || initialError}
        </div>
      ) : null}

      <TabNav
        defaultTab="roles"
        tabs={[
          { key: "roles", label: t(locale, "admin.rbac.tab.roles"), content: rolesTab },
          { key: "permissions", label: t(locale, "admin.rbac.tab.permissions"), content: permissionsTab },
          { key: "assign", label: t(locale, "admin.rbac.tab.assign"), content: assignTab },
          { key: "bindings", label: t(locale, "admin.rbac.tab.bindings"), content: bindingsTab },
          { key: "policies", label: t(locale, "admin.rbac.tab.policies"), content: policiesTab },
        ]}
      />
    </div>
  );
}
