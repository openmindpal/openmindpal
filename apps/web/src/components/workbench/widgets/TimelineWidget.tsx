"use client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  title: string;
  description?: string;
  timestamp: string;
  color?: string;
  icon?: string;
}

export interface TimelineWidgetProps {
  events: TimelineEvent[];
  title?: string;
  locale?: string;
}

// ─── Palette ─────────────────────────────────────────────────────────────────

const TIMELINE_COLORS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6",
];
const TIMELINE_BG = [
  "rgba(99,102,241,.06)", "rgba(14,165,233,.06)", "rgba(16,185,129,.06)", "rgba(245,158,11,.06)", "rgba(239,68,68,.06)",
  "rgba(139,92,246,.06)", "rgba(236,72,153,.06)", "rgba(20,184,166,.06)",
];

const TL_CSS = `
.__tl_item{opacity:0;transform:translateX(-12px);animation:__tlSlideIn .4s ease-out forwards}
@keyframes __tlSlideIn{to{opacity:1;transform:none}}
.__tl_card{transition:box-shadow .2s,transform .15s}
.__tl_card:hover{box-shadow:0 4px 20px rgba(0,0,0,.07);transform:translateX(4px)}
.__tl_dot{transition:transform .2s,box-shadow .2s}
.__tl_item:hover .__tl_dot{transform:scale(1.3);box-shadow:0 0 0 4px var(--dot-bg,rgba(99,102,241,.15))}
.__tl_line{background:linear-gradient(180deg,var(--sl-border,#e2e8f0) 0%,transparent 100%)}
`;

// ─── Component ───────────────────────────────────────────────────────────────

export function TimelineWidget(props: TimelineWidgetProps) {
  const { events, title, locale = "zh-CN" } = props;

  if (!events.length) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
        <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>⏳</div>
        No timeline events
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <style>{TL_CSS}</style>
      {title && (
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: "var(--sl-fg, #1e293b)", display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", padding: "1px 8px", borderRadius: 10, background: "var(--sl-bg,#f1f5f9)" }}>{events.length}</span>
        </div>
      )}
      <div style={{ position: "relative", paddingLeft: 32 }}>
        {/* Gradient vertical line */}
        <div className="__tl_line" style={{ position: "absolute", left: 11, top: 4, bottom: 4, width: 2, borderRadius: 1 }} />
        {events.map((event, idx) => {
          const color = event.color || TIMELINE_COLORS[idx % TIMELINE_COLORS.length];
          const bg = TIMELINE_BG[idx % TIMELINE_BG.length];
          const formattedDate = formatDate(event.timestamp, locale);

          return (
            <div
              key={event.id}
              className="__tl_item"
              style={{ position: "relative", paddingBottom: idx === events.length - 1 ? 0 : 16, animationDelay: `${idx * 80}ms` }}
            >
              {/* Dot */}
              <div
                className="__tl_dot"
                style={{
                  position: "absolute", left: -25, top: 12,
                  width: 12, height: 12, borderRadius: "50%",
                  background: color, border: "2.5px solid white",
                  boxShadow: `0 0 0 2.5px ${color}25`,
                  ["--dot-bg" as any]: `${color}20`,
                }}
              />
              {/* Content card */}
              <div
                className="__tl_card"
                style={{
                  padding: "10px 14px", borderRadius: 10,
                  background: bg, border: `1px solid ${color}18`,
                  borderLeft: `3px solid ${color}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "var(--sl-fg, #1e293b)", display: "flex", alignItems: "center", gap: 6 }}>
                    {event.icon && <span style={{ fontSize: 15 }}>{event.icon}</span>}
                    {event.title}
                  </div>
                  <div style={{ fontSize: 10, color: "#94a3b8", whiteSpace: "nowrap", padding: "2px 8px", borderRadius: 6, background: "rgba(255,255,255,.7)" }}>
                    {formattedDate}
                  </div>
                </div>
                {event.description && (
                  <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.55, marginTop: 2 }}>
                    {event.description}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(timestamp: string, locale: string): string {
  try {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return timestamp;
    return d.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return timestamp;
  }
}

export default TimelineWidget;
