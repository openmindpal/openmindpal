"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { t } from "@/lib/i18n";

export function ViewPrefsPanel(props: {
  locale: string;
  pageName: string;
  currentVariant: string;
  currentDensity: string;
  availableColumns: string[];
  currentColumns: string[];
}) {
  const router = useRouter();
  const sp = useSearchParams();

  const [variant, setVariant] = useState(props.currentVariant || "table");
  const [density, setDensity] = useState(props.currentDensity || "comfortable");
  const [cols, setCols] = useState<string[]>(props.currentColumns);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const colSet = useMemo(() => new Set(cols), [cols]);

  function updateUrl(next: { v?: string; density?: string; cols?: string[] }) {
    const qs = new URLSearchParams(sp.toString());
    qs.set("lang", props.locale);
    if (next.v) qs.set("v", next.v);
    if (next.density) qs.set("density", next.density);
    if (next.cols) qs.set("cols", next.cols.join(","));
    router.push(`/p/${encodeURIComponent(props.pageName)}?${qs.toString()}`);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/ui/pages/${encodeURIComponent(props.pageName)}/view-prefs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ prefs: { layout: { variant, density }, list: { columns: cols } } }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(String(json?.errorCode ?? "SAVE_FAILED"));
      setMsg(t(props.locale, "entity.viewPrefs.saved"));
    } catch (e: any) {
      setMsg(String(e?.message ?? t(props.locale, "entity.viewPrefs.failed")));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/ui/pages/${encodeURIComponent(props.pageName)}/view-prefs`, {
        method: "DELETE",
        locale: props.locale,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(String(json?.errorCode ?? "RESET_FAILED"));
      setMsg(t(props.locale, "entity.viewPrefs.resetDone"));
      router.refresh();
    } catch (e: any) {
      setMsg(String(e?.message ?? t(props.locale, "entity.viewPrefs.failed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <details style={{ margin: "12px 0" }}>
      <summary style={{ cursor: "pointer" }}>{t(props.locale, "entity.viewPrefs.title")}</summary>
      <div style={{ display: "grid", gap: 12, padding: "12px 0", maxWidth: 860 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "entity.viewPrefs.variant")}</div>
            <select
              value={variant}
              onChange={(e) => {
                const v = e.target.value;
                setVariant(v);
                updateUrl({ v, density, cols });
              }}
              disabled={saving}
            >
              <option value="table">{t(props.locale, "entity.viewPrefs.variant.table")}</option>
              <option value="cards">{t(props.locale, "entity.viewPrefs.variant.cards")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "entity.viewPrefs.density")}</div>
            <select
              value={density}
              onChange={(e) => {
                const d = e.target.value;
                setDensity(d);
                updateUrl({ v: variant, density: d, cols });
              }}
              disabled={saving}
            >
              <option value="comfortable">{t(props.locale, "entity.viewPrefs.density.comfortable")}</option>
              <option value="compact">{t(props.locale, "entity.viewPrefs.density.compact")}</option>
            </select>
          </label>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <div>{t(props.locale, "entity.viewPrefs.columns")}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {props.availableColumns.map((c) => (
              <label key={c} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={colSet.has(c)}
                  disabled={saving}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const next = checked ? Array.from(new Set([...cols, c])) : cols.filter((x) => x !== c);
                    setCols(next);
                    updateUrl({ v: variant, density, cols: next });
                  }}
                />
                {c}
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={save} disabled={saving}>
            {t(props.locale, "entity.viewPrefs.save")}
          </button>
          <button type="button" onClick={reset} disabled={saving}>
            {t(props.locale, "entity.viewPrefs.reset")}
          </button>
          {msg ? <span style={{ opacity: 0.75 }}>{msg}</span> : null}
        </div>
      </div>
    </details>
  );
}
