"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import type { I18nText } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader } from "@/components/ui";

type UiPageVersion = {
  title?: I18nText | string;
  pageType?: string;
  params?: unknown;
  dataBindings?: unknown;
  actionBindings?: unknown;
  ui?: unknown;
  version?: number;
};

type UiPageRow = {
  name: string;
  draft?: UiPageVersion | null;
  latestReleased?: UiPageVersion | null;
};

type UiPagesResponse = { scope?: { scopeType?: string; scopeId?: string }; pages?: UiPageRow[] };
type UiPageDetail = { draft?: UiPageVersion | null; released?: UiPageVersion | null };
type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export default function AdminUiClient(props: { locale: string; initialPages: UiPagesResponse | null }) {
  const [pages, setPages] = useState<UiPagesResponse | null>(props.initialPages);
  const [schemaName, setSchemaName] = useState("core");
  const [entityName, setEntityName] = useState("notes");
  const [selectedName, setSelectedName] = useState<string>("");
  const [selected, setSelected] = useState<UiPageDetail | null>(null);
  const [uiText, setUiText] = useState<string>("");
  const [uiError, setUiError] = useState<string>("");
  const scope = pages?.scope;
  const rows = useMemo(() => {
    return Array.isArray(pages?.pages) ? pages.pages : [];
  }, [pages]);

  async function refresh() {
    const res = await fetch(`${API_BASE}/ui/pages`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setPages(res.ok ? ((await res.json()) as UiPagesResponse) : null);
  }

  async function generateDefaults() {
    const res = await fetch(`${API_BASE}/ui/page-templates/generate`, {
      method: "POST",
      headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
      body: JSON.stringify({ schemaName, entityName, overwriteStrategy: "overwrite_draft" }),
    });
    await refresh();
    if (!res.ok) throw new Error("generate_failed");
  }

  async function publish(name: string) {
    const res = await fetch(`${API_BASE}/ui/pages/${encodeURIComponent(name)}/publish`, { method: "POST", headers: apiHeaders(props.locale) });
    await refresh();
    if (!res.ok) throw new Error("publish_failed");
  }

  async function rollback(name: string) {
    const res = await fetch(`${API_BASE}/ui/pages/${encodeURIComponent(name)}/rollback`, { method: "POST", headers: apiHeaders(props.locale) });
    await refresh();
    if (!res.ok) throw new Error("rollback_failed");
  }

  async function loadPage(name: string) {
    const res = await fetch(`${API_BASE}/ui/pages/${encodeURIComponent(name)}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error("load_failed");
    setSelectedName(name);
    const detail = (json && typeof json === "object" ? (json as UiPageDetail) : null) ?? null;
    setSelected(detail);
    setUiText(JSON.stringify(detail?.draft?.ui ?? null, null, 2));
    setUiError("");
  }

  async function saveDraftUi() {
    setUiError("");
    if (!selectedName) return;
    if (!selected?.draft) {
      setUiError("no draft");
      return;
    }
    try {
      const parsed = uiText.trim() ? JSON.parse(uiText) : null;
      const draft = selected.draft;
      const body = {
        title: draft.title ?? undefined,
        pageType: draft.pageType,
        params: draft.params ?? undefined,
        dataBindings: draft.dataBindings ?? undefined,
        actionBindings: draft.actionBindings ?? undefined,
        ui: parsed ?? undefined,
      };
      const res = await fetch(`${API_BASE}/ui/pages/${encodeURIComponent(selectedName)}/draft`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const o = json && typeof json === "object" ? (json as ApiError) : {};
        const msgVal = o.message;
        const msg =
          msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, props.locale) : msgVal != null ? String(msgVal) : res.statusText;
        throw new Error(`${o.errorCode ?? "ERROR"}: ${msg}`);
      }
      await refresh();
      await loadPage(selectedName);
    } catch (e: unknown) {
      setUiError(errMsg(e));
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "admin.ui.title")}
        description={
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
            scopeType={scope?.scopeType ?? "-"} scopeId={scope?.scopeId ?? "-"}
          </span>
        }
      />
      <div style={{ marginBottom: 16 }}>
        <span style={{ marginRight: 8 }}>schemaName:</span>
        <input value={schemaName} onChange={(e) => setSchemaName(e.target.value)} style={{ width: 160, marginRight: 12 }} />
        <span style={{ marginRight: 8 }}>entityName:</span>
        <input value={entityName} onChange={(e) => setEntityName(e.target.value)} style={{ width: 160, marginRight: 12 }} />
        <button onClick={generateDefaults}>{t(props.locale, "admin.ui.generateDraft")}</button>
      </div>

      <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th align="left">name</th>
            <th align="left">pageType</th>
            <th align="left">title</th>
            <th align="left">draft</th>
            <th align="left">released</th>
            <th align="left">actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p: UiPageRow) => {
            const released = p.latestReleased ?? null;
            const draft = p.draft ?? null;
            return (
              <tr key={p.name} style={{ borderTop: "1px solid #ddd" }}>
                <td>{p.name}</td>
                <td>{released?.pageType ?? draft?.pageType ?? ""}</td>
                <td>{text(released?.title ?? draft?.title, props.locale)}</td>
                <td>{draft ? "yes" : "no"}</td>
                <td>{released ? `v${released.version}` : "no"}</td>
                <td>
                  <Link href={`/p/${encodeURIComponent(p.name)}`}>{t(props.locale, "admin.ui.view")}</Link>
                  <button style={{ marginLeft: 8 }} onClick={() => loadPage(p.name)} disabled={!draft}>
                    {t(props.locale, "admin.ui.editUi")}
                  </button>
                  <button style={{ marginLeft: 8 }} onClick={() => publish(p.name)} disabled={!draft}>
                    {t(props.locale, "admin.ui.publish")}
                  </button>
                  <button style={{ marginLeft: 8 }} onClick={() => rollback(p.name)} disabled={!released}>
                    {t(props.locale, "admin.ui.rollback")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selectedName ? (
        <div style={{ marginTop: 16 }}>
          <h2>
            {t(props.locale, "admin.ui.draftEditorTitlePrefix")}
            {selectedName}
          </h2>
          {!selected?.draft ? <p>no draft</p> : null}
          <textarea
            rows={16}
            value={uiText}
            onChange={(e) => setUiText(e.target.value)}
            style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
          />
          {uiError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{uiError}</pre> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={saveDraftUi} disabled={!selected?.draft}>
              {t(props.locale, "admin.ui.saveDraftUi")}
            </button>
            <button
              onClick={() => {
                setSelectedName("");
                setSelected(null);
                setUiText("");
                setUiError("");
              }}
            >
              {t(props.locale, "admin.ui.close")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
