"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RetrievalLogRow = {
  id: string;
  createdAt: string;
  candidateCount: number;
  returnedCount: number | null;
  degraded: boolean;
  rankPolicy: string | null;
};
type RetrievalLogsResp = ApiError & { logs?: RetrievalLogRow[] };

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

export default function RetrievalLogsClient(props: { locale: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(0);
  const [data, setData] = useState<RetrievalLogsResp | null>(null);

  const [rankPolicy, setRankPolicy] = useState("");
  const [degraded, setDegraded] = useState<"" | "true" | "false">("");
  const [limit, setLimit] = useState("50");
  const [offset, setOffset] = useState("0");

  const rows = useMemo(() => (Array.isArray(data?.logs) ? data!.logs! : []), [data]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      const nLimit = Number(limit);
      const nOffset = Number(offset);
      if (Number.isFinite(nLimit) && nLimit > 0) q.set("limit", String(nLimit));
      if (Number.isFinite(nOffset) && nOffset >= 0) q.set("offset", String(nOffset));
      if (rankPolicy.trim()) q.set("rankPolicy", rankPolicy.trim());
      if (degraded) q.set("degraded", degraded);
      const res = await apiFetch(`/governance/knowledge/retrieval-logs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as RetrievalLogsResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeLogs")}
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

      <Card title={t(props.locale, "gov.changesets.filterTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.retrievalLogs.rankPolicy")}</span>
            <input value={rankPolicy} onChange={(e) => setRankPolicy(e.target.value)} style={{ width: 260 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.retrievalLogs.degraded")}</span>
            <select value={degraded} onChange={(e) => setDegraded(e.target.value === "true" ? "true" : e.target.value === "false" ? "false" : "")}>
              <option value="">all</option>
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.retrievalLogs.limit")}</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.retrievalLogs.offset")}</span>
            <input value={offset} onChange={(e) => setOffset(e.target.value)} style={{ width: 90 }} />
          </label>
          <button disabled={busy} onClick={refresh}>
            {t(props.locale, "action.apply")}
          </button>
        </div>
      </Card>

      <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
        <thead>
          <tr>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.id")}</th>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.createdAt")}</th>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.candidateCount")}</th>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.returnedCount")}</th>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.degraded")}</th>
            <th align="left">{t(props.locale, "gov.retrievalLogs.col.rankPolicy")}</th>
            <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.id}</td>
              <td>{r.createdAt}</td>
              <td>{String(r.candidateCount)}</td>
              <td>{r.returnedCount == null ? "-" : String(r.returnedCount)}</td>
              <td>{r.degraded ? <Badge>true</Badge> : <Badge>false</Badge>}</td>
              <td>{r.rankPolicy ?? "-"}</td>
              <td>
                <Link href={`/gov/knowledge/retrieval-logs/${encodeURIComponent(r.id)}?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.open")}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

