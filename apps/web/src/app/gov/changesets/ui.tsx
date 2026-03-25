"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ChangeSetRow = { id: string; title?: string; scope_type?: string; scope_id?: string; status?: string; created_at?: string };
type ChangeSetsResponse = ApiError & { changesets?: ChangeSetRow[] };
type PipelineRow = { changesetId: string; mode: string; gates: Array<{ gateType: string; status: string; required: boolean }>; warningsCount: number };
type PipelinesResponse = ApiError & { pipelines?: PipelineRow[] };

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

export default function ChangeSetsClient(props: { locale: string; initial: unknown; initialStatus: number; initialPipelines: unknown; initialPipelinesStatus: number }) {
  const [scope, setScope] = useState<"space" | "tenant" | "">( "");
  const [limit, setLimit] = useState<string>("20");
  const [data, setData] = useState<ChangeSetsResponse | null>((props.initial as ChangeSetsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [pipes, setPipes] = useState<PipelinesResponse | null>((props.initialPipelines as PipelinesResponse) ?? null);
  const [pipesStatus, setPipesStatus] = useState<number>(props.initialPipelinesStatus);
  const [error, setError] = useState<string>("");

  const [title, setTitle] = useState<string>("");
  const [createScope, setCreateScope] = useState<"space" | "tenant">("space");
  const [canaryTargetsText, setCanaryTargetsText] = useState<string>("");
  const [creating, setCreating] = useState<boolean>(false);

  const items = useMemo(() => (Array.isArray(data?.changesets) ? data!.changesets! : []), [data]);
  const pipelinesById = useMemo(() => {
    const arr = Array.isArray(pipes?.pipelines) ? pipes!.pipelines! : [];
    const m = new Map<string, PipelineRow>();
    for (const p of arr) m.set(p.changesetId, p);
    return m;
  }, [pipes]);

  function translated(key: string, fallback: string) {
    const out = t(props.locale, key);
    return out === key ? fallback : out;
  }

  function scopeTypeText(v: string) {
    if (v === "space") return t(props.locale, "scope.space");
    if (v === "tenant") return t(props.locale, "scope.tenant");
    return v;
  }

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await apiFetch(`/governance/changesets?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ChangeSetsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    const pRes = await apiFetch(`/governance/changesets/pipelines?${q.toString()}&mode=full`, { locale: props.locale, cache: "no-store" });
    setPipesStatus(pRes.status);
    const pJson: unknown = await pRes.json().catch(() => null);
    setPipes((pJson as PipelinesResponse) ?? null);
  }

  async function create() {
    setError("");
    setCreating(true);
    try {
      const canaryTargets = canaryTargetsText
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50);
      const res = await apiFetch(`/governance/changesets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ title, scope: createScope, canaryTargets: canaryTargets.length ? canaryTargets : undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setTitle("");
      setCanaryTargetsText("");
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setCreating(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.changesets.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <Badge>{pipesStatus}</Badge>
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesets.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.changesets.scope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : e.target.value === "space" ? "space" : "")}>
                <option value="">{t(props.locale, "gov.changesets.scopeAll")}</option>
                <option value="space">{t(props.locale, "scope.space")}</option>
                <option value="tenant">{t(props.locale, "scope.tenant")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.changesets.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 100 }} />
            </label>
            <button onClick={refresh}>{t(props.locale, "action.apply")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesets.createTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.changesets.titleLabel")}</div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t(props.locale, "gov.changesets.titlePlaceholder")} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.changesets.scope")}</div>
              <select value={createScope} onChange={(e) => setCreateScope(e.target.value === "tenant" ? "tenant" : "space")}>
                <option value="space">{t(props.locale, "scope.space")}</option>
                <option value="tenant">{t(props.locale, "scope.tenant")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.changesets.canaryTargets")}</div>
              <input
                value={canaryTargetsText}
                onChange={(e) => setCanaryTargetsText(e.target.value)}
                placeholder={t(props.locale, "gov.changesets.canaryTargetsPlaceholder")}
              />
            </label>
            <div>
              <button onClick={create} disabled={!title.trim() || creating}>
                {creating ? t(props.locale, "action.creating") : t(props.locale, "action.create")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.changesets.listTitle")}</span>
              <Badge>{items.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.changesets.table.id")}</th>
              <th align="left">{t(props.locale, "gov.changesets.titleCol")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.scope")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.status")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.gates")}</th>
              <th align="left">{t(props.locale, "gov.changesets.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((cs) => (
              <tr key={cs.id}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{cs.id}</td>
                <td>{cs.title ?? "-"}</td>
                <td>
                  {scopeTypeText(cs.scope_type ?? "-")}:{cs.scope_id ?? "-"}
                </td>
                <td>{cs.status ? translated(`gov.changesets.status.${cs.status}`, cs.status) : "-"}</td>
                <td>
                  {(() => {
                    const p = pipelinesById.get(cs.id);
                    if (!p) return "-";
                    const fails = p.gates.filter((g) => g.status === "fail").length;
                    const warns = p.gates.filter((g) => g.status === "warn").length;
                    const unknowns = p.gates.filter((g) => g.status === "unknown").length;
                    return (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Badge>
                          {t(props.locale, "gov.changesets.gates.fail")}:{fails}
                        </Badge>
                        <Badge>
                          {t(props.locale, "gov.changesets.gates.warn")}:{warns}
                        </Badge>
                        {unknowns ? (
                          <Badge>
                            {t(props.locale, "gov.changesets.gates.unknown")}:{unknowns}
                          </Badge>
                        ) : null}
                        {p.warningsCount ? (
                          <Badge>
                            {t(props.locale, "gov.changesets.gates.warnings")}:{p.warningsCount}
                          </Badge>
                        ) : null}
                      </div>
                    );
                  })()}
                </td>
                <td>{cs.created_at ?? "-"}</td>
                <td>
                  <Link href={`/gov/changesets/${encodeURIComponent(cs.id)}?lang=${encodeURIComponent(props.locale)}`}>
                    {t(props.locale, "action.open")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
