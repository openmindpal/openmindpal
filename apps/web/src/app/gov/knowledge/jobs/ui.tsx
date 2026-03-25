"use client";

import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type JobsResp = ApiError & { jobs?: unknown[] };

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

export default function KnowledgeJobsClient(props: { locale: string }) {
  const [kind, setKind] = useState<"index" | "embedding" | "ingest">("index");
  const [statusFilter, setStatusFilter] = useState("");
  const [limit, setLimit] = useState("50");
  const [offset, setOffset] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [httpStatus, setHttpStatus] = useState<number>(0);
  const [data, setData] = useState<JobsResp | null>(null);

  const rows = useMemo(() => (Array.isArray(data?.jobs) ? data!.jobs! : []), [data]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      const nLimit = Number(limit);
      const nOffset = Number(offset);
      if (Number.isFinite(nLimit) && nLimit > 0) q.set("limit", String(nLimit));
      if (Number.isFinite(nOffset) && nOffset >= 0) q.set("offset", String(nOffset));
      if (statusFilter.trim()) q.set("status", statusFilter.trim());

      const path =
        kind === "index"
          ? `/governance/knowledge/index-jobs?${q.toString()}`
          : kind === "embedding"
            ? `/governance/knowledge/embedding-jobs?${q.toString()}`
            : `/governance/knowledge/ingest-jobs?${q.toString()}`;
      const res = await apiFetch(path, { locale: props.locale, cache: "no-store" });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as JobsResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeJobs")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{httpStatus || "-"}</Badge>
            <button disabled={busy} onClick={refresh}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.changesets.filterTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.kind")}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value === "embedding" ? "embedding" : e.target.value === "ingest" ? "ingest" : "index")}>
              <option value="index">index</option>
              <option value="embedding">embedding</option>
              <option value="ingest">ingest</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.status")}</span>
            <input value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 180 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.limit")}</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.offset")}</span>
            <input value={offset} onChange={(e) => setOffset(e.target.value)} style={{ width: 90 }} />
          </label>
          <button disabled={busy} onClick={refresh}>
            {t(props.locale, "action.apply")}
          </button>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeJobs.jobsTitle")}>
        <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.status")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.attempt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const rec = r && typeof r === "object" ? (r as Record<string, unknown>) : null;
              const id = rec ? String(rec.id ?? idx) : String(idx);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{rec ? String(rec.status ?? "-") : "-"}</td>
                  <td>{rec ? String(rec.attempt ?? "-") : "-"}</td>
                  <td>{rec ? String(rec.updatedAt ?? "-") : "-"}</td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "gov.knowledgeJobs.json")}</summary>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(r, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
