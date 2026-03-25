"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, padding: 24 }}>
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(220,38,38,0.8)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: "rgba(15,23,42,0.92)", margin: 0 }}>Rendering Error</h2>
      <p style={{ fontSize: 14, color: "rgba(15,23,42,0.60)", margin: 0, textAlign: "center", maxWidth: 480 }}>
        {error.message || "An unexpected error occurred."}
      </p>
      {error.digest && (
        <code style={{ fontSize: 12, color: "rgba(15,23,42,0.45)", fontFamily: "var(--font-geist-mono, monospace)" }}>
          digest: {error.digest}
        </code>
      )}
      <button
        onClick={reset}
        style={{
          marginTop: 8, padding: "8px 20px", fontSize: 14, fontWeight: 500,
          border: "1px solid rgba(15,23,42,0.15)", borderRadius: 8, cursor: "pointer",
          background: "#fff", color: "rgba(15,23,42,0.85)",
        }}
      >
        Retry
      </button>
    </div>
  );
}
