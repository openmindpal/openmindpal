"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText, toApiError } from "@/lib/apiError";
import { Card, PageHeader, Table, StatusBadge } from "@/components/ui";

type WorkbenchPlugin = { workbenchKey?: string; displayName?: any; description?: any; status?: string; updatedAt?: string };
type WorkbenchPluginVersion = { version?: number; status?: string; updatedAt?: string };
type WorkbenchListItem = { plugin?: WorkbenchPlugin; latestReleased?: WorkbenchPluginVersion | null; draft?: WorkbenchPluginVersion | null };

function pickI18n(locale: string, v: any) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  if (typeof v[locale] === "string") return v[locale];
  if (typeof v["zh-CN"] === "string") return v["zh-CN"];
  const first = Object.values(v).find((x) => typeof x === "string");
  return typeof first === "string" ? first : "";
}

export default function GovWorkbenchesClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [itemsRes, setItemsRes] = useState<{ status: number; json: any }>(props.initial?.items ?? { status: 0, json: null });
  const [q, setQ] = useState("");

  const [createKey, setCreateKey] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");

  const items = useMemo(() => (Array.isArray(itemsRes?.json?.items) ? (itemsRes.json.items as WorkbenchListItem[]) : []), [itemsRes]);
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((it) => {
      const p = it.plugin ?? {};
      const key = String(p.workbenchKey ?? "").toLowerCase();
      const name = pickI18n(props.locale, p.displayName).toLowerCase();
      return key.includes(kw) || name.includes(kw);
    });
  }, [items, q, props.locale]);

  const refresh = useCallback(async () => {
    setError("");
    const res = await apiFetch(`/workbenches`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setItemsRes({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

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

  async function createPlugin() {
    await runAction(async () => {
      const key = createKey.trim();
      if (!key) throw toApiError({ errorCode: "BAD_REQUEST", message: t(props.locale, "error.missingWorkbenchKey") });
      const displayName = createName.trim() ? { [props.locale]: createName.trim() } : undefined;
      const description = createDesc.trim() ? { [props.locale]: createDesc.trim() } : undefined;
      const idem = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function" ? `wb-create-${(crypto as any).randomUUID()}` : `wb-create-${Date.now()}`;
      const res = await apiFetch(`/workbenches`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idem },
        locale: props.locale,
        body: JSON.stringify({ workbenchKey: key, displayName, description }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setCreateKey("");
      setCreateName("");
      setCreateDesc("");
      setNotice(t(props.locale, "gov.workbenches.created"));
      await refresh();
    });
  }

  const baseGov = `/gov/workbenches?lang=${encodeURIComponent(props.locale)}`;

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.workbenches.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={itemsRes.status} />
            <button onClick={refresh} disabled={busy}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {notice ? <pre style={{ color: "seagreen", whiteSpace: "pre-wrap" }}>{notice}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.createTitle")}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.workbenchKey")}</div>
              <input value={createKey} onChange={(e) => setCreateKey(e.target.value)} placeholder="my-workbench" />
            </label>
            <label>
              <div className="muted">{t(props.locale, "gov.workbenches.field.displayName")}</div>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={t(props.locale, "gov.workbenches.placeholder.displayName")} />
            </label>
            <label style={{ minWidth: 260 }}>
              <div className="muted">{t(props.locale, "gov.workbenches.field.description")}</div>
              <input value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} placeholder={t(props.locale, "gov.workbenches.placeholder.description")} />
            </label>
            <button onClick={createPlugin} disabled={busy}>{t(props.locale, "action.create")}</button>
            <Link href={baseGov} style={{ marginLeft: "auto" }}>{t(props.locale, "action.open")}</Link>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workbenches.listTitle")}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(props.locale, "gov.workbenches.searchPlaceholder")} style={{ minWidth: 320 }} />
            <span className="muted">{t(props.locale, "gov.workbenches.countLabel")}: {filtered.length}</span>
          </div>
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "gov.workbenches.table.key")}</th>
                <th>{t(props.locale, "gov.workbenches.table.name")}</th>
                <th>{t(props.locale, "gov.workbenches.table.status")}</th>
                <th>{t(props.locale, "gov.workbenches.table.draft")}</th>
                <th>{t(props.locale, "gov.workbenches.table.released")}</th>
                <th>{t(props.locale, "gov.workbenches.table.updatedAt")}</th>
                <th>{t(props.locale, "gov.workbenches.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it, idx) => {
                const p = it.plugin ?? {};
                const key = String(p.workbenchKey ?? "");
                const name = pickI18n(props.locale, p.displayName);
                const draftV = it.draft?.version != null ? String(it.draft.version) : "";
                const relV = it.latestReleased?.version != null ? String(it.latestReleased.version) : "";
                return (
                  <tr key={`${key}_${idx}`}>
                    <td>{key}</td>
                    <td>{name}</td>
                    <td>{String(p.status ?? "")}</td>
                    <td>{draftV || "-"}</td>
                    <td>{relV || "-"}</td>
                    <td>{String(p.updatedAt ?? "")}</td>
                    <td>
                      <Link href={`/gov/workbenches/${encodeURIComponent(key)}?lang=${encodeURIComponent(props.locale)}`}>
                        {t(props.locale, "action.view")}
                      </Link>
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
