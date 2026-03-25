"use client";

import { useMemo, useState } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  date: string; // ISO date string (YYYY-MM-DD or full ISO)
  color?: string;
  description?: string;
}

export interface CalendarWidgetProps {
  events: CalendarEvent[];
  title?: string;
  locale?: string;
}

// ─── Palette ─────────────────────────────────────────────────────────────────

const EVENT_COLORS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6",
];

const CAL_CSS = `
.__cal_day{transition:background .15s,transform .15s,box-shadow .15s;cursor:default}
.__cal_day:hover{background:rgba(99,102,241,.06)!important;transform:scale(1.08);box-shadow:0 2px 8px rgba(99,102,241,.1);z-index:1}
.__cal_dot{transition:transform .15s}
.__cal_day:hover .__cal_dot{transform:scale(1.4)}
.__cal_nav{transition:background .15s,color .15s}
.__cal_nav:hover{background:var(--sl-accent-bg,#eef2ff)!important;color:#6366f1!important}
.__cal_ev{transition:background .15s,padding-left .15s}
.__cal_ev:hover{background:rgba(99,102,241,.05);padding-left:4px;border-radius:6px}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = [];
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseEventDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "";
    return toDateKey(d);
  } catch {
    return "";
  }
}

const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Component ───────────────────────────────────────────────────────────────

export function CalendarWidget(props: CalendarWidgetProps) {
  const { events, title } = props;

  // Determine initial month from events or use current
  const initialDate = useMemo(() => {
    if (events.length > 0) {
      const d = new Date(events[0].date);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date();
  }, [events]);

  const [year, setYear] = useState(initialDate.getFullYear());
  const [month, setMonth] = useState(initialDate.getMonth());

  // Build event map: dateKey → events[]
  const eventMap = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const ev of events) {
      const key = parseEventDate(ev.date);
      if (key) {
        (map[key] ??= []).push(ev);
      }
    }
    return map;
  }, [events]);

  const days = useMemo(() => getMonthDays(year, month), [year, month]);
  const firstDayOfWeek = days[0]?.getDay() ?? 0;
  const today = toDateKey(new Date());

  const weekdays = WEEKDAYS_EN;
  const months = MONTHS_EN;

  const prevMonth = () => {
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
  };

  return (
    <div style={{ padding: 16 }}>
      <style>{CAL_CSS}</style>
      {title && (
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, color: "var(--sl-fg, #1e293b)", display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", padding: "1px 8px", borderRadius: 10, background: "var(--sl-bg,#f1f5f9)" }}>{events.length}</span>
        </div>
      )}

      {/* Month Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, padding: "6px 4px", borderRadius: 10, background: "var(--sl-bg,#f8fafc)" }}>
        <button onClick={prevMonth} className="__cal_nav" style={navBtnStyle}>◀</button>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--sl-fg, #1e293b)", letterSpacing: "0.02em" }}>
          {months[month]} {year}
        </div>
        <button onClick={nextMonth} className="__cal_nav" style={navBtnStyle}>▶</button>
      </div>

      {/* Weekday headers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 6 }}>
        {weekdays.map((wd) => (
          <div key={wd} style={{ textAlign: "center", fontSize: 10, color: "#94a3b8", padding: "4px 0", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {wd}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {/* Empty cells for padding */}
        {Array.from({ length: firstDayOfWeek }, (_, i) => (
          <div key={`pad-${i}`} style={{ minHeight: 40 }} />
        ))}
        {/* Actual days */}
        {days.map((d) => {
          const dateKey = toDateKey(d);
          const dayEvents = eventMap[dateKey] ?? [];
          const isToday = dateKey === today;
          return (
            <div
              key={dateKey}
              className="__cal_day"
              style={{
                minHeight: 44, padding: "3px 4px", borderRadius: 8, position: "relative",
                background: isToday ? "rgba(99,102,241,0.1)" : dayEvents.length > 0 ? "rgba(99,102,241,0.02)" : "transparent",
                border: isToday ? "1.5px solid rgba(99,102,241,0.35)" : "1px solid transparent",
              }}
              title={dayEvents.map((e) => e.title).join(", ")}
            >
              <div style={{ fontSize: 11, fontWeight: isToday ? 700 : dayEvents.length > 0 ? 600 : 400, color: isToday ? "#6366f1" : dayEvents.length > 0 ? "var(--sl-fg, #1e293b)" : "var(--sl-fg, #94a3b8)", textAlign: "center" }}>
                {d.getDate()}
              </div>
              {/* Event dots */}
              {dayEvents.length > 0 && (
                <div style={{ display: "flex", justifyContent: "center", gap: 2, marginTop: 3, flexWrap: "wrap" }}>
                  {dayEvents.slice(0, 3).map((ev, idx) => (
                    <div
                      key={ev.id}
                      className="__cal_dot"
                      style={{ width: 5, height: 5, borderRadius: "50%", background: ev.color || EVENT_COLORS[idx % EVENT_COLORS.length], boxShadow: `0 0 3px ${ev.color || EVENT_COLORS[idx % EVENT_COLORS.length]}40` }}
                    />
                  ))}
                  {dayEvents.length > 3 && (
                    <div style={{ fontSize: 8, color: "#94a3b8", lineHeight: "5px", fontWeight: 700 }}>+{dayEvents.length - 3}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Event list for current month */}
      {(() => {
        const monthEvents = events.filter((ev) => {
          const key = parseEventDate(ev.date);
          return key.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`);
        });
        if (monthEvents.length === 0) return null;
        return (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--sl-border, #e2e8f0)", paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>
              Events this month ({monthEvents.length})
            </div>
            {monthEvents.slice(0, 5).map((ev, idx) => (
              <div key={ev.id} className="__cal_ev" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 12 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: ev.color || EVENT_COLORS[idx % EVENT_COLORS.length], flexShrink: 0, boxShadow: `0 0 4px ${ev.color || EVENT_COLORS[idx % EVENT_COLORS.length]}30` }} />
                <span style={{ color: "#94a3b8", flexShrink: 0, fontSize: 10, fontWeight: 600, minWidth: 24 }}>
                  {new Date(ev.date).getDate()}
                </span>
                <span style={{ color: "var(--sl-fg, #1e293b)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                  {ev.title}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--sl-border, #e2e8f0)",
  background: "var(--sl-surface, #fff)",
  color: "var(--sl-fg, #64748b)",
  cursor: "pointer",
  fontSize: 12,
};

export default CalendarWidget;
