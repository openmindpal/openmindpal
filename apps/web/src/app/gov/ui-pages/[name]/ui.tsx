"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText, safeJsonString, toApiError } from "@/lib/apiError";
import { Card, PageHeader, StatusBadge } from "@/components/ui";

function shallowDiffKeys(a: any, b: any) {
  const ka = a && typeof a === "object" && !Array.isArray(a) ? Object.keys(a) : [];
  const kb = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
  const all = Array.from(new Set([...ka, ...kb]));
  const changed = all.filter((k) => safeJsonString(a?.[k]) !== safeJsonString(b?.[k]));
  return { all, changed };
}

function extractTitle(v: any, locale: string): string {
  const title = v?.title;
  if (!title) return "";
  if (typeof title === "string") return title;
  if (typeof title === "object") {
    return title[locale] || title["zh-CN"] || title["en-US"] || Object.values(title).find(Boolean) as string || "";
  }
  return "";
}

function inferSource(name: string, draft: any, released: any): string {
  if (name.startsWith("nl2ui.")) return "nl2ui";
  const p = draft?.params ?? released?.params;
  if (p?.nl2uiConfig) return "nl2ui";
  if (name.match(/^[a-z_]+\.(list|detail|new|edit)$/)) return "template";
  return "manual";
}

function friendlyPageType(locale: string, pageType: string): string {
  if (!pageType) return "-";
  const key = `gov.uiPages.pageType.${pageType}`;
  const val = t(locale, key);
  return val !== key ? val : pageType;
}

function fmtTime(raw: string | undefined | null): string {
  if (!raw) return "-";
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw);
    return d.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return String(raw); }
}

function InfoRow(props: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
      <div style={{ width: 120, flexShrink: 0, color: "#64748b", fontSize: 13 }}>{props.label}</div>
      <div style={{ flex: 1, fontSize: 13, fontFamily: props.mono ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" : undefined }}>{props.value}</div>
    </div>
  );
}

export default function GovUiPageDetailClient(props: { locale: string; name: string; initial: any }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageRes, setPageRes] = useState<{ status: number; json: any }>(props.initial?.page ?? { status: 0, json: null });
  const [showDraftJson, setShowDraftJson] = useState(false);
  const [showReleasedJson, setShowReleasedJson] = useState(false);

  const draft = useMemo(() => (pageRes?.json?.draft ?? null) as any, [pageRes]);
  const released = useMemo(() => (pageRes?.json?.released ?? null) as any, [pageRes]);

  const [draftText, setDraftText] = useState(() => safeJsonString(draft ?? { pageType: "page.generic", params: {}, dataBindings: [], actionBindings: [], ui: null }));

  const diff = useMemo(() => shallowDiffKeys(draft, released), [draft, released]);

  const effective = draft || released;
  const pageTitle = extractTitle(effective, props.locale) || t(props.locale, "gov.uiPages.noTitle");
  const pageType = effective?.pageType ?? "";
  const source = inferSource(props.name, draft, released);
  const entityName = effective?.params?.entityName ?? "-";
  const layoutVariant = effective?.ui?.layout?.variant ?? "-";
  const dataBindings: any[] = Array.isArray(effective?.dataBindings) ? effective.dataBindings : [];
  const uiBlocks: any[] = Array.isArray(effective?.ui?.blocks) ? effective.ui.blocks : [];

  const statusKey = draft && released ? "gov.uiPages.summary.statusBoth" : released ? "gov.uiPages.summary.statusReleased" : "gov.uiPages.summary.statusDraft";
  const versionText = `${released ? t(props.locale, "gov.uiPages.version.released").replace("{version}", String(released.version ?? "")) : t(props.locale, "gov.uiPages.version.none")}${draft ? ` / ${t(props.locale, "gov.uiPages.version.draft").replace("{version}", String(draft.version ?? ""))}` : ""}`;

  const refresh = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/ui/pages/${encodeURIComponent(props.name)}`, { locale: props.locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      setPageRes({ status: res.status, json });
      if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    } finally {
      setBusy(false);
    }
  }, [props.locale, props.name]);

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    await runAction(async () => {
      const parsed = JSON.parse(draftText);
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `ui-draft-${(crypto as any).randomUUID()}` : `ui-draft-${Date.now()}`;
      const res = await apiFetch(`/ui/pages/${encodeURIComponent(props.name)}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify(parsed),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setNotice(t(props.locale, "gov.uiPages.draftSaved"));
      await refresh();
    });
  }

  async function handleDelete() {
    if (!confirm(t(props.locale, "gov.uiPages.action.confirmDelete"))) return;
    await runAction(async () => {
      const res = await apiFetch(`/ui/pages/${encodeURIComponent(props.name)}`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setNotice(t(props.locale, "gov.uiPages.deleted"));
      router.push(`/gov/ui-pages?lang=${encodeURIComponent(props.locale)}`);
    });
  }

  async function createChangesetWithItem(kind: "ui.page.publish" | "ui.page.rollback") {
    await runAction(async () => {
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `cs-${(crypto as any).randomUUID()}` : `cs-${Date.now()}`;
      const csRes = await apiFetch(`/governance/changesets`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ title: `${kind} ${props.name}`, scope: "space" }),
      });
      const csJson = await csRes.json().catch(() => null);
      if (!csRes.ok) throw toApiError(csJson);
      const csId = String((csJson as any)?.changeset?.id ?? "");
      if (!csId) throw toApiError({ errorCode: "INTERNAL_ERROR", message: t(props.locale, "error.missingChangesetId") });
      const itemRes = await apiFetch(`/governance/changesets/${encodeURIComponent(csId)}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ kind, pageName: props.name }),
      });
      const itemJson = await itemRes.json().catch(() => null);
      if (!itemRes.ok) throw toApiError(itemJson);
      router.push(`/gov/changesets/${encodeURIComponent(csId)}?lang=${encodeURIComponent(props.locale)}`);
    });
  }

  const sourceStyle: React.CSSProperties = source === "nl2ui"
    ? { background: "#ede9fe", color: "#7c3aed", padding: "2px 8px", borderRadius: 4, fontSize: 12 }
    : source === "template"
    ? { background: "#dcfce7", color: "#16a34a", padding: "2px 8px", borderRadius: 4, fontSize: 12 }
    : { background: "#f1f5f9", color: "#64748b", padding: "2px 8px", borderRadius: 4, fontSize: 12 };

  return (
    <div>
      <PageHeader
        title={pageTitle}
        actions={
          <>
            <StatusBadge locale={props.locale} status={pageRes.status} />
            <Link href={`/p/${encodeURIComponent(props.name)}?lang=${encodeURIComponent(props.locale)}`}
              style={{ padding: "4px 12px", background: "#0ea5e9", color: "#fff", borderRadius: 6, textDecoration: "none", fontSize: 13 }}>
              {t(props.locale, "gov.uiPages.action.preview")}
            </Link>
            <button onClick={refresh} disabled={busy}>{t(props.locale, "action.refresh")}</button>
            <Link href={`/gov/ui-pages?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.back")}</Link>
          </>
        }
      />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {notice ? <pre style={{ color: "seagreen", whiteSpace: "pre-wrap" }}>{notice}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.uiPages.summary.title")}>
          <InfoRow label={t(props.locale, "gov.uiPages.summary.pageTitle")} value={<strong>{pageTitle}</strong>} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.pageName")} value={props.name} mono />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.pageType")} value={friendlyPageType(props.locale, pageType)} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.source")} value={<span style={sourceStyle}>{t(props.locale, `gov.uiPages.source.${source}`)}</span>} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.entity")} value={entityName} mono />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.layout")} value={layoutVariant} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.status")} value={t(props.locale, statusKey)} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.version")} value={versionText} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.createdAt")} value={fmtTime(effective?.createdAt)} />
          <InfoRow label={t(props.locale, "gov.uiPages.summary.updatedAt")} value={fmtTime(effective?.updatedAt)} />
        </Card>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card title={t(props.locale, "gov.uiPages.dataBindings.title")}>
          {dataBindings.length === 0 ? (
            <p style={{ color: "#94a3b8", fontSize: 13 }}>{t(props.locale, "gov.uiPages.dataBindings.empty")}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {dataBindings.map((db: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid #f8fafc" }}>
                  <span style={{ color: "#64748b" }}>{t(props.locale, "gov.uiPages.dataBindings.target")}:</span>
                  <span style={{ fontFamily: "monospace" }}>{db.target ?? db.kind ?? "-"}</span>
                  <span style={{ color: "#64748b", marginLeft: 8 }}>{t(props.locale, "gov.uiPages.dataBindings.entity")}:</span>
                  <strong>{db.entityName ?? db.params?.entityName ?? "-"}</strong>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={t(props.locale, "gov.uiPages.uiBlocks.title")}>
          {uiBlocks.length === 0 ? (
            <p style={{ color: "#94a3b8", fontSize: 13 }}>{t(props.locale, "gov.uiPages.uiBlocks.empty")}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {uiBlocks.map((block: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid #f8fafc" }}>
                  <span style={{ color: "#64748b" }}>{t(props.locale, "gov.uiPages.uiBlocks.slot")}:</span>
                  <span>{block.slot ?? "-"}</span>
                  <span style={{ color: "#64748b", marginLeft: 8 }}>{t(props.locale, "gov.uiPages.uiBlocks.component")}:</span>
                  <strong style={{ fontFamily: "monospace" }}>{block.componentId ?? "-"}</strong>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.uiPages.compareTitle")}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="muted">
              {t(props.locale, "gov.uiPages.diffKeysLabel")}: {diff.changed.length}/{diff.all.length}
              {diff.changed.length > 0 && ` — ${diff.changed.join(", ")}`}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.uiPages.draftTitle")}</span>
                <button onClick={() => setShowDraftJson(!showDraftJson)} style={{ fontSize: 12, cursor: "pointer", background: "none", border: "1px solid #e2e8f0", borderRadius: 4, padding: "2px 8px" }}>
                  {t(props.locale, showDraftJson ? "gov.uiPages.jsonToggle.hide" : "gov.uiPages.jsonToggle.show")}
                </button>
              </div>
              {showDraftJson && <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, background: "#f8fafc", padding: 12, borderRadius: 6, maxHeight: 400, overflow: "auto" }}>{safeJsonString(draft)}</pre>}
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{t(props.locale, "gov.uiPages.releasedTitle")}</span>
                <button onClick={() => setShowReleasedJson(!showReleasedJson)} style={{ fontSize: 12, cursor: "pointer", background: "none", border: "1px solid #e2e8f0", borderRadius: 4, padding: "2px 8px" }}>
                  {t(props.locale, showReleasedJson ? "gov.uiPages.jsonToggle.hide" : "gov.uiPages.jsonToggle.show")}
                </button>
              </div>
              {showReleasedJson && <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, background: "#f8fafc", padding: 12, borderRadius: 6, maxHeight: 400, overflow: "auto" }}>{safeJsonString(released)}</pre>}
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void createChangesetWithItem("ui.page.publish")} disabled={busy}>
              {t(props.locale, "gov.uiPages.action.publishViaChangeset")}
            </button>
            <button onClick={() => void createChangesetWithItem("ui.page.rollback")} disabled={busy}>
              {t(props.locale, "gov.uiPages.action.rollbackViaChangeset")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.uiPages.editTitle")}>
          <label>
            <div className="muted">{t(props.locale, "gov.uiPages.field.draftJson")}</div>
            <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} rows={18} style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={saveDraft} disabled={busy}>{t(props.locale, "action.save")}</button>
            <button onClick={handleDelete} disabled={busy} style={{ color: "#ef4444" }}>
              {t(props.locale, "gov.uiPages.action.delete")}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
