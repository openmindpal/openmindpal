"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type SafetyPolicyType = "content" | "injection" | "risk";

type PolicyRow = { policyId: string; policyType: SafetyPolicyType; name: string; createdAt: string };
type PolicyListResp = { items?: Array<{ policy: PolicyRow; activeVersion?: number | null; latest?: any | null }> } & ApiError;

type VersionsResp = { policy?: PolicyRow; versions?: Array<{ version: number; status: string; policyDigest: string; createdAt: string; publishedAt?: string | null }> } & ApiError;
type VersionResp = { version?: any } & ApiError;
type DiffResp = { summary?: any } & ApiError;

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

export default function SafetyPoliciesClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<PolicyListResp | null>((props.initial as PolicyListResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [filterType, setFilterType] = useState<SafetyPolicyType | "">( "");
  const [newType, setNewType] = useState<SafetyPolicyType>("content");
  const [newName, setNewName] = useState<string>("content-default");
  const [newJson, setNewJson] = useState<string>(JSON.stringify({ version: "v1", mode: "audit_only", denyTargets: ["model:invoke", "tool:execute"], denyHitTypes: ["token"] }, null, 2));

  const [selectedPolicyId, setSelectedPolicyId] = useState<string>("");
  const [versions, setVersions] = useState<VersionsResp | null>(null);
  const [versionDetail, setVersionDetail] = useState<VersionResp | null>(null);
  const [diff, setDiff] = useState<DiffResp | null>(null);
  const [diffFrom, setDiffFrom] = useState<number>(0);
  const [diffTo, setDiffTo] = useState<number>(0);
  const [overrideSpaceId, setOverrideSpaceId] = useState<string>("");
  const [overrideTarget, setOverrideTarget] = useState<{ policyId: string; version: number } | null>(null);

  const items = useMemo(() => (Array.isArray((data as any)?.items) ? ((data as any).items as any[]) : []), [data]);
  const filtered = useMemo(() => {
    if (!filterType) return items;
    return items.filter((x) => String(x?.policy?.policyType ?? "") === filterType);
  }, [filterType, items]);

  async function refresh() {
    setError("");
    const qs = filterType ? `?policyType=${encodeURIComponent(filterType)}&limit=50` : "?limit=50";
    const res = await apiFetch(`/governance/safety-policies${qs}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as PolicyListResp) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as any) ?? { errorCode: String(res.status) }));
  }

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    await runAction(async () => {
      const policyJson = (() => {
        try {
          return JSON.parse(newJson);
        } catch {
          return { raw: newJson };
        }
      })();
      const res = await apiFetch(`/governance/safety-policies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ policyType: newType, name: newName.trim(), policyJson }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const policyId = String((json as any)?.version?.policyId ?? "");
      if (policyId) setSelectedPolicyId(policyId);
    });
  }

  async function loadVersions(policyId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/versions?limit=50`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setVersions((json as VersionsResp) ?? null);
      setVersionDetail(null);
      setDiff(null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadVersion(policyId: string, version: number) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(String(version))}`, {
        locale: props.locale,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setVersionDetail((json as VersionResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadDiff(policyId: string, from: number, to: number) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/safety-policies/${encodeURIComponent(policyId)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`, {
        locale: props.locale,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setDiff((json as DiffResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createChangeSetWithItems(title: string, items: any[], canaryTargets?: string[]) {
    const csRes = await apiFetch(`/governance/changesets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      locale: props.locale,
      body: JSON.stringify({ title, scope: "tenant", ...(canaryTargets ? { canaryTargets } : {}) }),
    });
    const csJson: any = await csRes.json().catch(() => null);
    if (!csRes.ok) throw toApiError(csJson);
    const id = String(csJson?.changeset?.id ?? "");
    if (!id) throw toApiError({ errorCode: "ERROR", message: "missing changeset id" });
    for (const it of items) {
      const res = await apiFetch(`/governance/changesets/${encodeURIComponent(id)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify(it),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(j);
    }
    return id;
  }

  async function publishAndActivate(policyId: string, version: number) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy publish ${policyId}@${version}`, [
        { kind: "policy.publish", policyId, version },
        { kind: "policy.set_active", policyId, version },
      ]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    });
  }

  async function rollbackActive(policyId: string) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy rollback ${policyId}`, [{ kind: "policy.rollback", policyId }]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    });
  }

  async function setOverride(policyId: string, version: number, spaceId: string) {
    await runAction(async () => {
      const id = await createChangeSetWithItems(`policy override ${policyId}@${version} space=${spaceId}`, [{ kind: "policy.set_override", policyId, version, spaceId }], [spaceId]);
      window.location.href = `/gov/changesets/${encodeURIComponent(id)}?lang=${encodeURIComponent(props.locale)}`;
    });
  }

  const initialError = useMemo(() => (status >= 400 ? errText(props.locale, data) : ""), [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.safetyPolicies.title")}
        description={<StatusBadge locale={props.locale} status={status} />}
        actions={
          <>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <Link href={`/gov/changesets?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.safetyPolicies.changesets")}</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.safetyPolicies.createDraftTitle")}>
          <div style={{ display: "grid", gap: 8, maxWidth: 900 }}>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8, alignItems: "center" }}>
              <div>{t(props.locale, "gov.safetyPolicies.policyType")}</div>
              <select value={newType} onChange={(e) => setNewType(e.target.value as SafetyPolicyType)} disabled={busy}>
                <option value="content">{t(props.locale, "gov.safetyPolicies.type.content")}</option>
                <option value="injection">{t(props.locale, "gov.safetyPolicies.type.injection")}</option>
                <option value="risk">{t(props.locale, "gov.safetyPolicies.type.risk")}</option>
              </select>
              <div>{t(props.locale, "gov.safetyPolicies.name")}</div>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy} />
            </div>
            <div>{t(props.locale, "gov.safetyPolicies.policyJson")}</div>
            <textarea value={newJson} onChange={(e) => setNewJson(e.target.value)} rows={10} disabled={busy} />
            <button onClick={createDraft} disabled={busy || !newName.trim()}>
              {t(props.locale, "gov.safetyPolicies.createDraftButton")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.safetyPolicies.policiesTitle")}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <span>{t(props.locale, "gov.safetyPolicies.filter")}</span>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value as any)} disabled={busy}>
              <option value="">{t(props.locale, "gov.safetyPolicies.all")}</option>
              <option value="content">{t(props.locale, "gov.safetyPolicies.type.content")}</option>
              <option value="injection">{t(props.locale, "gov.safetyPolicies.type.injection")}</option>
              <option value="risk">{t(props.locale, "gov.safetyPolicies.type.risk")}</option>
            </select>
          </div>
          <Table header={<span>{t(props.locale, "gov.safetyPolicies.items")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.policyId")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.type")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.name")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.active")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.latest")}</th>
                <th align="left">{t(props.locale, "gov.safetyPolicies.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((x: any) => (
                <tr key={String(x?.policy?.policyId ?? "")}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{String(x?.policy?.policyId ?? "")}</td>
                  <td>
                    <Badge>{String(x?.policy?.policyType ?? "")}</Badge>
                  </td>
                  <td>{String(x?.policy?.name ?? "")}</td>
                  <td>{x?.activeVersion ?? "-"}</td>
                  <td>{x?.latest?.version ?? "-"}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() => {
                        const pid = String(x?.policy?.policyId ?? "");
                        setSelectedPolicyId(pid);
                        loadVersions(pid);
                      }}
                    >
                      {t(props.locale, "gov.safetyPolicies.versions")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {selectedPolicyId && versions?.versions ? (
        <div style={{ marginTop: 16 }}>
          <Card title={`${t(props.locale, "gov.safetyPolicies.policyTitle")} ${selectedPolicyId}`}>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <button onClick={() => loadVersions(selectedPolicyId)} disabled={busy}>
                  {t(props.locale, "gov.safetyPolicies.reloadVersions")}
                </button>
                <button onClick={() => rollbackActive(selectedPolicyId)} disabled={busy}>
                  {t(props.locale, "gov.safetyPolicies.rollbackActive")}
                </button>
              </div>

              <Table header={<span>{t(props.locale, "gov.safetyPolicies.versionsHeader")}</span>}>
                <thead>
                  <tr>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.version")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.status")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.digest")}</th>
                    <th align="left">{t(props.locale, "gov.safetyPolicies.table.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.versions!.map((v) => (
                    <tr key={String(v.version)}>
                      <td>{v.version}</td>
                      <td>
                        <Badge>{v.status}</Badge>
                      </td>
                      <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{v.policyDigest.slice(0, 12)}</td>
                      <td style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => loadVersion(selectedPolicyId, v.version)} disabled={busy}>
                          {t(props.locale, "gov.safetyPolicies.view")}
                        </button>
                        <button onClick={() => publishAndActivate(selectedPolicyId, v.version)} disabled={busy || v.status === "released"}>
                          {t(props.locale, "gov.safetyPolicies.publishActivate")}
                        </button>
                        <button
                          onClick={() => {
                            setOverrideTarget({ policyId: selectedPolicyId, version: v.version });
                            setOverrideSpaceId("");
                          }}
                          disabled={busy || v.status !== "released"}
                        >
                          {t(props.locale, "gov.safetyPolicies.setOverride")}
                        </button>
                        <button
                          onClick={() => {
                            if (!diffFrom) setDiffFrom(v.version);
                            else setDiffTo(v.version);
                          }}
                          disabled={busy}
                        >
                          {t(props.locale, "gov.safetyPolicies.pickDiff")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>

              {overrideTarget ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", background: "rgba(15,23,42,0.03)", borderRadius: 6, paddingInline: 12, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.safetyPolicies.overrideLabel")}</span>
                  <input
                    value={overrideSpaceId}
                    onChange={(e) => setOverrideSpaceId(e.target.value)}
                    placeholder={t(props.locale, "gov.safetyPolicies.overridePlaceholder")}
                    style={{ width: 220 }}
                    disabled={busy}
                  />
                  <button
                    disabled={busy || !overrideSpaceId.trim()}
                    onClick={() => {
                      if (overrideTarget && overrideSpaceId.trim()) {
                        setOverride(overrideTarget.policyId, overrideTarget.version, overrideSpaceId.trim());
                        setOverrideTarget(null);
                        setOverrideSpaceId("");
                      }
                    }}
                  >
                    {t(props.locale, "gov.safetyPolicies.overrideConfirm")}
                  </button>
                  <button onClick={() => setOverrideTarget(null)} disabled={busy}>
                    {t(props.locale, "action.cancel")}
                  </button>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span>{t(props.locale, "gov.safetyPolicies.diff")}</span>
                <input style={{ width: 80 }} value={diffFrom || ""} onChange={(e) => setDiffFrom(Number(e.target.value) || 0)} />
                <input style={{ width: 80 }} value={diffTo || ""} onChange={(e) => setDiffTo(Number(e.target.value) || 0)} />
                <button disabled={busy || !diffFrom || !diffTo} onClick={() => loadDiff(selectedPolicyId, diffFrom, diffTo)}>
                  {t(props.locale, "gov.safetyPolicies.diff")}
                </button>
              </div>

              {diff ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(diff, null, 2)}</pre> : null}
              {versionDetail ? <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(versionDetail, null, 2)}</pre> : null}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

