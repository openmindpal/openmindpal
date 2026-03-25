"use client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StatItem {
  label: string;
  value: number | string;
  change?: number;      // percent change (positive = up)
  prefix?: string;      // e.g. "$", "¥"
  suffix?: string;      // e.g. "%", "items"
  color?: string;
}

export interface StatsRowWidgetProps {
  stats: StatItem[];
  title?: string;
  locale?: string;
}

// ─── Palette ────────────────────────────────────────────────────────────────

const STAT_GRADIENTS = [
  ["#6366f1", "#818cf8"],
  ["#0ea5e9", "#38bdf8"],
  ["#10b981", "#34d399"],
  ["#f59e0b", "#fbbf24"],
  ["#ef4444", "#f87171"],
  ["#8b5cf6", "#a78bfa"],
];

const STAT_CSS = `
.__st_card{transition:box-shadow .2s,transform .15s}
.__st_card:hover{box-shadow:0 6px 20px rgba(99,102,241,.1)!important;transform:translateY(-2px)}
.__st_num{animation:__stCountIn .5s ease-out}
@keyframes __stCountIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
`;

// ─── Component ──────────────────────────────────────────────────────────────

export function StatsRowWidget(props: StatsRowWidgetProps) {
  const { stats, title } = props;

  if (!stats.length) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
        No stats
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0" }}>
      <style>{STAT_CSS}</style>
      {title && (
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, padding: "0 4px", color: "var(--sl-fg, #1e293b)" }}>
          {title}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, 1fr)`, gap: 12 }}>
        {stats.map((stat, i) => {
          const [c1, c2] = STAT_GRADIENTS[i % STAT_GRADIENTS.length];
          const hasChange = stat.change != null && stat.change !== 0;
          const up = (stat.change ?? 0) >= 0;
          const val = typeof stat.value === "number" ? stat.value.toLocaleString() : stat.value;

          return (
            <div
              key={i}
              className="__st_card"
              style={{
                padding: "16px 18px",
                borderRadius: 12,
                background: "var(--sl-surface, #fff)",
                border: "1px solid var(--sl-border, #e5e7eb)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {/* Top accent */}
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${c1}, ${c2})`, opacity: 0.6 }} />
              {/* Label */}
              <div style={{ fontSize: 11, fontWeight: 500, color: "#94a3b8", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {stat.label}
              </div>
              {/* Value */}
              <div className="__st_num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", background: `linear-gradient(135deg, ${c1}, ${c2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", lineHeight: 1.1 }}>
                {stat.prefix ?? ""}{val}{stat.suffix ?? ""}
              </div>
              {/* Change indicator */}
              {hasChange && (
                <div style={{
                  marginTop: 6, fontSize: 11, fontWeight: 600,
                  color: up ? "#10b981" : "#ef4444",
                  display: "inline-flex", alignItems: "center", gap: 3,
                  padding: "1px 8px", borderRadius: 10,
                  background: up ? "rgba(16,185,129,.08)" : "rgba(239,68,68,.08)",
                }}>
                  <span style={{ fontSize: 9 }}>{up ? "▲" : "▼"}</span>
                  {Math.abs(stat.change!).toFixed(1)}%
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default StatsRowWidget;
