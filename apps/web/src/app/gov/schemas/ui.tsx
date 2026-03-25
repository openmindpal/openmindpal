"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type SchemasResp = { schemas?: any[] } & ApiError;

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function SchemasClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<SchemasResp | null>((props.initial as SchemasResp) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [q, setQ] = useState<string>("");

  const schemas = useMemo(() => (Array.isArray((data as any)?.schemas) ? ((data as any).schemas as any[]) : []), [data]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return schemas;
    return schemas.filter((x) => String(x?.name ?? "").toLowerCase().includes(s));
  }, [q, schemas]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/schemas`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setData((json as SchemasResp) ?? null);
      if (!res.ok) setError(errText(props.locale, (json as any) ?? { errorCode: String(res.status) }));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => (status >= 400 ? errText(props.locale, data) : ""), [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.schemas.title")}
        description={<StatusBadge locale={props.locale} status={status} />}
        actions={
          <>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <Link href={`/gov/changesets?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "gov.schemas.changesets")}</Link>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.searchTitle")}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(props.locale, "gov.schemas.searchPlaceholder")} />
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.schemas.latestTitle")}>
          <Table header={<span>{t(props.locale, "gov.schemas.schemasHeader")}</span>}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "gov.schemas.table.name")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.version")}</th>
                <th align="left">{t(props.locale, "gov.schemas.table.publishedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => (
                <tr key={String(s?.name ?? "")}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                    <Link href={`/gov/schemas/${encodeURIComponent(String(s?.name ?? ""))}?lang=${encodeURIComponent(props.locale)}`}>{String(s?.name ?? "")}</Link>
                  </td>
                  <td>{String(s?.version ?? "-")}</td>
                  <td>{String(s?.publishedAt ?? "-")}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
