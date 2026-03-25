"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import DynamicBlockRenderer, { type Nl2UiConfig } from "./DynamicBlockRenderer";

interface Nl2UiGeneratorProps {
  locale: string;
}

export function Nl2UiGenerator(props: Nl2UiGeneratorProps) {
  const { locale } = props;
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<Nl2UiConfig | null>(null);
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [savedPage, setSavedPage] = useState<{ pageName: string; pageUrl: string } | null>(null);


  const handleGenerate = useCallback(async () => {
    if (!input.trim()) return;
    
    setLoading(true);
    setError("");
    
    try {
      const res = await apiFetch("/nl2ui/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({
          userInput: input,
        }),
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data = await res.json();
      if (data.success && data.config) {
        setConfig(data.config);
        setSavedPage(null);
      } else {
        throw new Error("Generation failed");
      }
    } catch (err: any) {
      console.error("NL2UI generation failed:", err);
      setError(err.message || "Generation failed. Please retry.");
    } finally {
      setLoading(false);
    }
  }, [input, locale]);

  const handleSaveAsPage = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await apiFetch("/nl2ui/save-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({
          config,
          title: input.slice(0, 80) || "NL2UI Page",
          autoPublish: true,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { success: boolean; pageName: string; pageUrl: string };
        if (data.success) {
          setSavedPage({ pageName: data.pageName, pageUrl: data.pageUrl });
        }
      }
    } catch { /* ignore */ }
    setSaving(false);
  }, [config, input, locale]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  }, [handleGenerate]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      {/* Input */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16, textAlign: "center" }}>
          🎨 {t(locale, "nl2ui.title")}
        </h2>
        <p style={{ fontSize: 14, color: "#64748b", textAlign: "center", marginBottom: 16 }}>
          {t(locale, "nl2ui.description")}
        </p>
        
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(locale, "nl2ui.placeholder")}
            rows={3}
            style={{
              flex: 1,
              padding: 12,
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              fontSize: 14,
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !input.trim()}
            style={{
              padding: "12px 24px",
              borderRadius: 8,
              border: "none",
              background: loading ? "#cbd5e1" : "#6366f1",
              color: "white",
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              transition: "all 0.2s",
              minWidth: 100,
            }}
          >
            {loading ? "⏳ Generating..." : "✨ Generate"}
          </button>
        </div>
      </div>
      
      {/* Error */}
      {error && (
        <div style={{
          padding: 16,
          borderRadius: 8,
          background: "#fef2f2",
          border: "1px solid #fecaca",
          color: "#dc2626",
          marginBottom: 24,
        }}>
          ❌ {error}
        </div>
      )}
      
      {/* Skeleton */}
      {loading && (
        <div style={{
          borderRadius: 12,
          border: "1px solid #e2e8f0",
          background: "white",
          overflow: "hidden",
          marginBottom: 24,
          animation: "fadeIn 0.3s ease-out",
        }}>
          <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
            <div style={{ width: 60, height: 10, borderRadius: 5, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite" }} />
            <div style={{ width: 48, height: 10, borderRadius: 5, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", animationDelay: "0.15s" }} />
            <div style={{ width: 72, height: 10, borderRadius: 5, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", animationDelay: "0.3s" }} />
          </div>
          <div style={{ padding: 16, display: "grid", gap: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1, height: i === 0 ? 32 : 24, borderRadius: 6, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", animationDelay: `${i * 0.1}s` }} />
                <div style={{ flex: 1, height: i === 0 ? 32 : 24, borderRadius: 6, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", animationDelay: `${i * 0.1 + 0.15}s` }} />
                <div style={{ flex: 1, height: i === 0 ? 32 : 24, borderRadius: 6, background: "linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", animationDelay: `${i * 0.1 + 0.3}s` }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid #e2e8f0", color: "#94a3b8", fontSize: 13 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1", animation: "pulse 1s ease-in-out infinite" }} />
            {t(locale, "nl2ui.generating")}
          </div>
        </div>
      )}
      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
      `}</style>

      {/* Generated UI */}
      {config && (
        <div style={{
          borderRadius: 12,
          border: "1px solid #e2e8f0",
          background: "white",
          boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
          overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            padding: "12px 16px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <div style={{ fontSize: 13, color: "#64748b" }}>
              🎯 {t(locale, "nl2ui.confidence")} {config.metadata?.confidence ?? "-"}
            </div>
            <button
              onClick={() => setConfig(null)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #e2e8f0",
                background: "white",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              ✕ {t(locale, "admin.ui.close")}
            </button>
            {/* Save as page */}
            {savedPage ? (
              <Link
                href={`${savedPage.pageUrl}?lang=${encodeURIComponent(locale)}`}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  background: "#ecfdf5",
                  border: "1px solid #a7f3d0",
                  color: "#059669",
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                ✅ {t(locale, "nl2ui.savedOpen")}
              </Link>
            ) : (
              <button
                onClick={handleSaveAsPage}
                disabled={saving}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #c7d2fe",
                  background: saving ? "#e2e8f0" : "#eef2ff",
                  color: saving ? "#94a3b8" : "#4f46e5",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                {saving
                  ? t(locale, "nl2ui.saving")
                  : t(locale, "nl2ui.saveAsPage")}
              </button>
            )}
          </div>
          
          {/* Render */}
          <DynamicBlockRenderer
            config={config}
            readOnly={!config.dataBindings?.length}
            locale={locale}
            enableLayoutEdit={true}
          />
        </div>
      )}
      
      {/* Empty state */}
      {!config && !loading && !error && (
        <div style={{
          padding: 60,
          textAlign: "center",
          color: "#94a3b8",
          border: "2px dashed #e2e8f0",
          borderRadius: 12,
          background: "linear-gradient(135deg, rgba(99,102,241,0.02), rgba(14,165,233,0.02))",
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎨</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
            {t(locale, "nl2ui.emptyState.title")}
          </div>
          <div style={{ fontSize: 14 }}>
            {t(locale, "nl2ui.emptyState.desc")}
          </div>
        </div>
      )}
    </div>
  );
}

export default Nl2UiGenerator;
