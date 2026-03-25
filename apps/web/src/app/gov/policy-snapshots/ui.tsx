"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type Cursor = { createdAt: string; snapshotId: string };
type PolicySnapshotRow = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
};
type ListResponse = ApiError & { items?: PolicySnapshotRow[]; nextCursor?: Cursor };

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

export default function GovPolicySnapshotsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ListResponse | null>((props.initial as ListResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [scope, setScope] = useState<"space" | "tenant">("space");
  const [subjectId, setSubjectId] = useState<string>("");
  const [resourceType, setResourceType] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [decision, setDecision] = useState<"" | "allow" | "deny">("");
  const [limit, setLimit] = useState<string>("50");

  const items = useMemo(() => (Array.isArray(data?.items) ? (data!.items as PolicySnapshotRow[]) : []), [data]);
  const nextCursor = data?.nextCursor;

  async function fetchList(params: { append: boolean; cursor?: Cursor }) {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (scope) q.set("scope", scope);
      if (subjectId.trim()) q.set("subjectId", subjectId.trim());
      if (resourceType.trim()) q.set("resourceType", resourceType.trim());
      if (action.trim()) q.set("action", action.trim());
      if (decision) q.set("decision", decision);
      const n = Number(limit);
      q.set("limit", String(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50));
      if (params.cursor?.createdAt && params.cursor?.snapshotId) {
        q.set("cursorCreatedAt", params.cursor.createdAt);
        q.set("cursorSnapshotId", params.cursor.snapshotId);
      }

      const res = await apiFetch(`/governance/policy/snapshots?${q.toString()}`, {
        locale: props.locale,
        cache: "no-store",
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as ListResponse) ?? {};
      if (!params.append) {
        setData(out);
      } else {
        const prev = items;
        const merged = [...prev, ...(Array.isArray(out.items) ? out.items : [])];
        setData({ ...out, items: merged });
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.policySnapshots.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={() => fetchList({ append: false })} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshots.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.scope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                <option value="space">{t(props.locale, "gov.policySnapshots.scopeSpace")}</option>
                <option value="tenant">{t(props.locale, "gov.policySnapshots.scopeTenant")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.subjectId")}</span>
              <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.resourceType")}</span>
              <input value={resourceType} onChange={(e) => setResourceType(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.action")}</span>
              <input value={action} onChange={(e) => setAction(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.decision")}</span>
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value === "allow" ? "allow" : e.target.value === "deny" ? "deny" : "")}
                disabled={busy}
              >
                <option value="">{t(props.locale, "gov.policySnapshots.decisionAll")}</option>
                <option value="allow">{t(props.locale, "gov.policySnapshots.decisionAllow")}</option>
                <option value="deny">{t(props.locale, "gov.policySnapshots.decisionDeny")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy} style={{ width: 80 }} />
            </label>
            <button onClick={() => fetchList({ append: false })} disabled={busy}>
              {t(props.locale, "gov.policySnapshots.search")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshots.listTitle")}>
          <Table
            header={
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  {t(props.locale, "gov.policySnapshots.count")}: {items.length}
                </div>
                <button onClick={() => fetchList({ append: true, cursor: nextCursor })} disabled={busy || !nextCursor}>
                  {t(props.locale, "gov.policySnapshots.loadMore")}
                </button>
              </div>
            }
          >
            <thead>
              <tr>
                <th>{t(props.locale, "gov.policySnapshots.createdAt")}</th>
                <th>{t(props.locale, "gov.policySnapshots.decision")}</th>
                <th>{t(props.locale, "gov.policySnapshots.resourceType")}</th>
                <th>{t(props.locale, "gov.policySnapshots.action")}</th>
                <th>{t(props.locale, "gov.policySnapshots.subjectId")}</th>
                <th>{t(props.locale, "gov.policySnapshots.spaceId")}</th>
                <th>{t(props.locale, "gov.policySnapshots.snapshotId")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const href = `/gov/policy-snapshots/${encodeURIComponent(r.snapshotId)}?lang=${encodeURIComponent(props.locale)}`;
                return (
                  <tr key={r.snapshotId}>
                    <td>{r.createdAt}</td>
                    <td>
                      <Badge>{r.decision}</Badge>
                    </td>
                    <td>{r.resourceType}</td>
                    <td>{r.action}</td>
                    <td>{r.subjectId}</td>
                    <td>{r.spaceId ?? ""}</td>
                    <td>
                      <a href={href}>{r.snapshotId}</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
