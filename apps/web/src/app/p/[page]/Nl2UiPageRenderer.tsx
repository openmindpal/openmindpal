"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DynamicBlockRenderer, { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import type { AreaLayoutItem } from "@/components/nl2ui/LayoutEditor";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";

interface Nl2UiPageRendererProps {
  config: Nl2UiConfig;
  locale: string;
  pageName: string;
  title: string;
  backHref: string;
  released?: {
    pageType?: string;
    title?: Record<string, string> | string | null;
    params?: Record<string, any> | null;
    dataBindings?: any[] | null;
    actionBindings?: any[] | null;
    ui?: any | null;
  };
}

export default function Nl2UiPageRenderer({ config, locale, pageName, title, backHref, released }: Nl2UiPageRendererProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  const layoutItemsRef = useRef<AreaLayoutItem[] | null>(null);
  const [hasLayoutChanges, setHasLayoutChanges] = useState(false);

  const savedLayoutItems: AreaLayoutItem[] | undefined = (config as any)._savedLayoutItems;

  const handleLayoutChange = useCallback((items: AreaLayoutItem[]) => {
    layoutItemsRef.current = items;
    setHasLayoutChanges(true);
  }, []);

  const handleSaveLayout = useCallback(async () => {
    if (!layoutItemsRef.current || !released) return;
    setSaving(true);
    setSaveStatus("idle");
    setSaveError("");

    try {
      const updatedNl2uiConfig = {
        ...config,
        _savedLayoutItems: layoutItemsRef.current,
      };

      const draftBody: Record<string, any> = {
        pageType: released.pageType ?? "entity.list",
        params: {
          ...(released.params ?? {}),
          nl2uiConfig: updatedNl2uiConfig,
        },
      };
      const rawTitle = released.title;
      if (rawTitle && typeof rawTitle === "object") {
        draftBody.title = rawTitle;
      } else {
        draftBody.title = { "zh-CN": title, "en-US": title };
      }
      if (Array.isArray(released.dataBindings) && released.dataBindings.length > 0) {
        draftBody.dataBindings = released.dataBindings;
      }
      if (Array.isArray(released.actionBindings) && released.actionBindings.length > 0) {
        draftBody.actionBindings = released.actionBindings;
      }

      const draftRes = await apiFetch(`/ui/pages/${encodeURIComponent(pageName)}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `nl2ui-layout-${Date.now()}`,
        },
        locale,
        body: JSON.stringify(draftBody),
      });

      if (!draftRes.ok) {
        const errBody = await draftRes.json().catch(() => null);
        const errMsg = typeof errBody?.message === "string"
          ? errBody.message
          : typeof errBody?.message === "object" && errBody.message
            ? (errBody.message[locale] || errBody.message["zh-CN"] || JSON.stringify(errBody.message))
            : `Draft save failed (${draftRes.status})`;
        throw new Error(errMsg);
      }

      const pubRes = await apiFetch(`/ui/pages/${encodeURIComponent(pageName)}/publish`, {
        method: "POST",
        locale,
      });

      if (!pubRes.ok) {
        const errBody = await pubRes.json().catch(() => null);
        const errMsg = typeof errBody?.message === "string"
          ? errBody.message
          : typeof errBody?.message === "object" && errBody.message
            ? (errBody.message[locale] || errBody.message["zh-CN"] || JSON.stringify(errBody.message))
            : `Publish failed (${pubRes.status})`;
        throw new Error(errMsg);
      }

      setSaveStatus("saved");
      setHasLayoutChanges(false);
      setTimeout(() => setSaveStatus("idle"), 2500);
      router.refresh();
    } catch (err: any) {
      setSaveStatus("error");
      setSaveError(err?.message ?? t(locale, "nl2ui.page.layoutSaveError"));
      setTimeout(() => setSaveStatus("idle"), 4000);
    } finally {
      setSaving(false);
    }
  }, [config, released, pageName, title, locale, router]);

  return (
    <main style={{
      minHeight: "100vh",
      background: "var(--sl-bg, #f8fafc)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    }}>
      <div style={{
        padding: "12px 24px",
        background: "var(--sl-surface, #fff)",
        borderBottom: "1px solid var(--sl-border, #e5e7eb)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}>
        <Link
          href={backHref}
          style={{
            fontSize: 13,
            color: "var(--sl-muted, #64748b)",
            textDecoration: "none",
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--sl-border, #e5e7eb)",
            background: "var(--sl-surface, #fff)",
            transition: "all .15s",
          }}
        >
          ← {t(locale, "back")}
        </Link>
        <h1 style={{
          fontSize: 18,
          fontWeight: 700,
          margin: 0,
          background: "linear-gradient(135deg, #6366f1, #0ea5e9)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          {title}
        </h1>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          padding: "2px 10px",
          borderRadius: 20,
          background: "#eef2ff",
          color: "#6366f1",
        }}>
          {t(locale, "nl2ui.page.badge")}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {saveStatus === "saved" && (
            <span style={{
              fontSize: 12,
              color: "#16a34a",
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              padding: "3px 10px",
              borderRadius: 6,
              fontWeight: 600,
            }}>
              ✓ {t(locale, "nl2ui.page.layoutSaved")}
            </span>
          )}
          {saveStatus === "error" && (
            <span style={{
              fontSize: 12,
              color: "#dc2626",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              padding: "3px 10px",
              borderRadius: 6,
              fontWeight: 600,
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              ✗ {saveError || t(locale, "nl2ui.page.layoutSaveError")}
            </span>
          )}
          {hasLayoutChanges && (
            <button
              onClick={handleSaveLayout}
              disabled={saving}
              style={{
                fontSize: 13,
                padding: "5px 16px",
                borderRadius: 6,
                border: "none",
                background: saving
                  ? "#94a3b8"
                  : "linear-gradient(135deg, #6366f1, #0ea5e9)",
                color: "#fff",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                transition: "all .15s",
                boxShadow: saving ? "none" : "0 2px 8px rgba(99,102,241,.25)",
              }}
            >
              {saving
                ? t(locale, "nl2ui.page.layoutSaving")
                : t(locale, "nl2ui.page.layoutSave")}
            </button>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: 24 }}>
        <DynamicBlockRenderer
          config={config}
          readOnly={false}
          locale={locale}
          enableLayoutEdit={true}
          initialLayoutItems={savedLayoutItems}
          onLayoutChange={handleLayoutChange}
        />
      </div>
    </main>
  );
}
