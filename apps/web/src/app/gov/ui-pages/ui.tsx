"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText } from "@/lib/apiError";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type PageVersion = {
  version?: number;
  status?: string;
  pageType?: string;
  title?: Record<string, string> | string | null;
  params?: { entityName?: string; nl2uiConfig?: any } | null;
  ui?: { layout?: { variant?: string }; blocks?: any[] } | null;
  createdAt?: string;
  updatedAt?: string;
};
type PageListItem = { name?: string; latestReleased?: PageVersion | null; draft?: PageVersion | null };

function extractTitle(v: PageVersion | null | undefined, locale: string): string {
  if (!v?.title) return "";
  if (typeof v.title === "string") return v.title;
  if (typeof v.title === "object") {
    return (v.title as any)[locale] || (v.title as any)["zh-CN"] || (v.title as any)["en-US"] || Object.values(v.title).find(Boolean) as string || "";
  }
  return "";
}

function inferSource(item: PageListItem): "nl2ui" | "template" | "manual" {
  const name = item.name ?? "";
  if (name.startsWith("nl2ui.")) return "nl2ui";
  const p = item.draft?.params ?? item.latestReleased?.params;
  if (p && (p as any).nl2uiConfig) return "nl2ui";
  // entity.list/edit pages with certain patterns from template generation
  if (name.match(/^[a-z_]+\.(list|detail|new|edit)$/)) return "template";
  return "manual";
}

function friendlyPageType(locale: string, pageType: string): string {
  const key = `gov.uiPages.pageType.${pageType}`;
  const val = t(locale, key);
  return val !== key ? val : pageType;
}

function fmtTime(raw: string | undefined): string {
  if (!raw) return "-";
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return raw; }
}

export default function GovUiPagesClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pagesRes, setPagesRes] = useState<{ status: number; json: any }>(props.initial?.pages ?? { status: 0, json: null });
  const [q, setQ] = useState("");

  const items = useMemo(() => (Array.isArray(pagesRes?.json?.pages) ? (pagesRes.json.pages as PageListItem[]) : []), [pagesRes]);
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) => {
      const title = extractTitle(it.draft, props.locale) || extractTitle(it.latestReleased, props.locale);
      const name = String(it.name ?? "");
      const hay = `${title} ${name}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [items, q, props.locale]);

  const refresh = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/ui/pages`, { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      setPagesRes({ status: res.status, json });
      if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusy(false);
    }
  }, [props.locale]);

  const sourceStyle = (src: string): React.CSSProperties => {
    if (src === "nl2ui") return { background: "#ede9fe", color: "#7c3aed", padding: "2px 8px", borderRadius: 4, fontSize: 12 };
    if (src === "template") return { background: "#dcfce7", color: "#16a34a", padding: "2px 8px", borderRadius: 4, fontSize: 12 };
    return { background: "#f1f5f9", color: "#64748b", padding: "2px 8px", borderRadius: 4, fontSize: 12 };
  };

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.uiPages.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={pagesRes.status} />
            <button onClick={refresh} disabled={busy}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.uiPages.listTitle")}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(props.locale, "gov.uiPages.searchPlaceholder")} style={{ minWidth: 320 }} />
            <span className="muted">{t(props.locale, "gov.uiPages.countLabel")}: {filtered.length}</span>
          </div>

          {filtered.length === 0 && !q ? (
            <p style={{ color: "#64748b", padding: "24px 0", textAlign: "center" }}>{t(props.locale, "gov.uiPages.empty")}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t(props.locale, "gov.uiPages.table.title")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.name")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.source")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.pageType")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.released")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.updatedAt")}</th>
                  <th>{t(props.locale, "gov.uiPages.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it, idx) => {
                  const name = String(it.name ?? "");
                  const titleText = extractTitle(it.draft, props.locale) || extractTitle(it.latestReleased, props.locale) || t(props.locale, "gov.uiPages.noTitle");
                  const source = inferSource(it);
                  const pageType = String(it.draft?.pageType ?? it.latestReleased?.pageType ?? "");
                  const relV = it.latestReleased?.version != null ? `v${it.latestReleased.version}` : "-";
                  const updatedAt = fmtTime(it.draft?.updatedAt ?? it.latestReleased?.updatedAt);
                  return (
                    <tr key={`${name}_${idx}`}>
                      <td style={{ fontWeight: 600, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Link href={`/gov/ui-pages/${encodeURIComponent(name)}?lang=${encodeURIComponent(props.locale)}`}
                          style={{ color: "#1e40af", textDecoration: "none" }}>
                          {titleText}
                        </Link>
                      </td>
                      <td style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace" }}>{name}</td>
                      <td><span style={sourceStyle(source)}>{t(props.locale, `gov.uiPages.source.${source}`)}</span></td>
                      <td>{friendlyPageType(props.locale, pageType)}</td>
                      <td>{relV}</td>
                      <td>{updatedAt}</td>
                      <td style={{ display: "flex", gap: 8 }}>
                        <Link href={`/p/${encodeURIComponent(name)}?lang=${encodeURIComponent(props.locale)}`}
                          style={{ color: "#0ea5e9", textDecoration: "none", fontSize: 13 }}>
                          {t(props.locale, "gov.uiPages.action.preview")}
                        </Link>
                        <Link href={`/gov/ui-pages/${encodeURIComponent(name)}?lang=${encodeURIComponent(props.locale)}`}
                          style={{ textDecoration: "none", fontSize: 13 }}>
                          {t(props.locale, "action.view")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
