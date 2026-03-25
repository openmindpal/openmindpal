"use client";

import { useCallback, useMemo, useId } from "react";
import { t } from "@/lib/i18n";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "number" | "gauge" | "sparkline" | "table";

export interface MetricCard {
  id: string;
  title: string;
  chartType: ChartType;
  metricName?: string;
  dimensions?: string[];
  measures?: string[];
  filters?: Record<string, any>;
  timeRange?: string;
  sortOrder: number;
}

export interface BiDashboardProps {
  cards: MetricCard[];
  onChange: (cards: MetricCard[]) => void;
  readOnly?: boolean;
  data?: Record<string, any[]>;
  locale?: string;
}

// ─── Palette ─────────────────────────────────────────────────────────────────

const PALETTE = [
  ["#6366f1", "#818cf8"], // indigo
  ["#0ea5e9", "#38bdf8"], // sky
  ["#10b981", "#34d399"], // emerald
  ["#f59e0b", "#fbbf24"], // amber
  ["#ef4444", "#f87171"], // red
  ["#8b5cf6", "#a78bfa"], // violet
  ["#ec4899", "#f472b6"], // pink
  ["#14b8a6", "#2dd4bf"], // teal
];
function pal(i: number) { return PALETTE[i % PALETTE.length]; }

// ─── Shared CSS animations (injected once, zero-dependency) ─────────────────

const BI_CSS = `
.__bi_bar{opacity:0;animation:__biFadeUp .5s cubic-bezier(.4,0,.2,1) forwards}
.__bi_bar:hover{filter:brightness(1.12)}
@keyframes __biFadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.__bi_line_path{stroke-dasharray:600;stroke-dashoffset:600;animation:__biDraw 1s ease-out forwards}
.__bi_area_fill{opacity:0;animation:__biFadeIn .6s .2s ease-out forwards}
@keyframes __biDraw{to{stroke-dashoffset:0}}
@keyframes __biFadeIn{to{opacity:1}}
.__bi_dot{opacity:0;animation:__biDotPop .3s ease-out forwards}
.__bi_dot:hover{r:5;filter:drop-shadow(0 0 5px var(--dot-c,#6366f1))}
@keyframes __biDotPop{from{opacity:0;r:0}to{opacity:1}}
.__bi_slice{opacity:0;transform-origin:center;animation:__biSliceIn .5s ease-out forwards;transition:transform .2s,filter .2s}
.__bi_slice:hover{transform:scale(1.05);filter:brightness(1.1) drop-shadow(0 2px 6px rgba(0,0,0,.15))}
@keyframes __biSliceIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
.__bi_gauge_arc{stroke-dasharray:200;stroke-dashoffset:200;animation:__biGaugeFill 1s .2s cubic-bezier(.4,0,.2,1) forwards}
@keyframes __biGaugeFill{to{stroke-dashoffset:var(--gauge-offset,0)}}
.__bi_spark_path{stroke-dasharray:400;stroke-dashoffset:400;animation:__biDraw .8s ease-out forwards}
.__bi_pulse{animation:__biPulse 1.5s ease-in-out infinite}
@keyframes __biPulse{0%,100%{opacity:1;r:3}50%{opacity:.5;r:5}}
.__bi_tbl_row{transition:background .15s}
.__bi_tbl_row:hover{background:rgba(99,102,241,.04)}
.__bi_card{transition:box-shadow .25s,transform .2s}
.__bi_card:hover{box-shadow:0 8px 30px rgba(99,102,241,0.10),0 1.5px 4px rgba(0,0,0,0.04)!important;transform:translateY(-2px)}
.__bi_card:hover .__bi_accent{opacity:1!important}
.__bi_kpi_num{animation:__biCountIn .6s ease-out}@keyframes __biCountIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _cardIdCounter = 0;
function generateCardId(): string { return `card_${Date.now()}_${++_cardIdCounter}`; }
function createCard(chartType: ChartType, title: string): MetricCard {
  return { id: generateCardId(), title, chartType, sortOrder: 0 };
}
function extractValues(data: any[], measure?: string) {
  return data.map((d, i) => ({
    label: d.label ?? d.dimension ?? d.name ?? `#${i + 1}`,
    value: Number(d[measure ?? "value"] ?? d.value ?? (i + 1) * 10),
  }));
}

// ─── Chart: Bar ─────────────────────────────────────────────────────────────

function BarChart(props: { data: any[]; measure?: string }) {
  const values = extractValues(props.data.slice(0, 12), props.measure);
  const max = Math.max(...values.map((v) => v.value), 1);
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 140, padding: "12px 0 4px" }}>
      {values.map((v, i) => {
        const [c1, c2] = pal(i);
        return (
          <div key={i} className="__bi_bar" style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0, gap: 4, animationDelay: `${i * 50}ms` }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: c1 }}>{v.value}</span>
            <div style={{
              width: "100%", maxWidth: 36,
              height: `${Math.max(6, (v.value / max) * 100)}%`,
              background: `linear-gradient(180deg, ${c1}, ${c2})`,
              borderRadius: "6px 6px 2px 2px",
              transition: "height 0.4s cubic-bezier(.4,0,.2,1)",
              boxShadow: `0 2px 8px ${c1}33`,
            }} />
            <span style={{ fontSize: 9, color: "var(--sl-muted, #94a3b8)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%", textAlign: "center" }}>
              {v.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Bezier helper ──────────────────────────────────────────────────────────

function bezierSmooth(points: number[][]): string {
  if (points.length < 2) return points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const parts: string[] = [`M${points[0][0]},${points[0][1]}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const t = 0.3;
    parts.push(`C${p1[0] + (p2[0] - p0[0]) * t},${p1[1] + (p2[1] - p0[1]) * t} ${p2[0] - (p3[0] - p1[0]) * t},${p2[1] - (p3[1] - p1[1]) * t} ${p2[0]},${p2[1]}`);
  }
  return parts.join(" ");
}

// ─── Chart: Line ─────────────────────────────────────────────────────────────

function LineChart(props: { data: any[]; measure?: string; uid?: string }) {
  const values = extractValues(props.data.slice(0, 24), props.measure);
  const nums = values.map((v) => v.value);
  const max = Math.max(...nums, 1);
  const W = 240, H = 110, PY = 10;
  const pts = nums.map((v, i) => [i / Math.max(nums.length - 1, 1) * W, H - PY - (v / max) * (H - PY * 2)]);
  const curve = bezierSmooth(pts);
  const [c1] = pal(0);
  const gid = `lineG_${props.uid ?? ""}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 130, overflow: "visible" }}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c1} stopOpacity="0.18" /><stop offset="100%" stopColor={c1} stopOpacity="0.01" /></linearGradient></defs>
      {[0.25, 0.5, 0.75].map((r) => <line key={r} x1={0} y1={H - PY - r * (H - PY * 2)} x2={W} y2={H - PY - r * (H - PY * 2)} stroke="var(--sl-border, #e5e7eb)" strokeWidth="0.5" strokeDasharray="3 2" />)}
      <path className="__bi_area_fill" d={`${curve} L${pts[pts.length - 1][0]},${H - PY} L${pts[0][0]},${H - PY} Z`} fill={`url(#${gid})`} />
      <path className="__bi_line_path" d={curve} fill="none" stroke={c1} strokeWidth="2.5" strokeLinecap="round" />
      {pts.map((p, i) => <circle key={i} className="__bi_dot" cx={p[0]} cy={p[1]} r="3.5" fill="#fff" stroke={c1} strokeWidth="2" style={{ animationDelay: `${0.3 + i * 0.04}s`, ["--dot-c" as any]: c1 }} />)}
    </svg>
  );
}

// ─── Chart: Area ─────────────────────────────────────────────────────────────

function AreaChart(props: { data: any[]; measure?: string; uid?: string }) {
  const values = extractValues(props.data.slice(0, 24), props.measure);
  const nums = values.map((v) => v.value);
  const max = Math.max(...nums, 1);
  const W = 240, H = 110, PY = 8;
  const pts = nums.map((v, i) => [i / Math.max(nums.length - 1, 1) * W, H - PY - (v / max) * (H - PY * 2)]);
  const curve = bezierSmooth(pts);
  const [c1, c2] = pal(2);
  const gid = `areaG_${props.uid ?? ""}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 130, overflow: "visible" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c1} stopOpacity="0.35" /><stop offset="100%" stopColor={c2} stopOpacity="0.03" /></linearGradient>
      </defs>
      <path className="__bi_area_fill" d={`${curve} L${pts[pts.length - 1][0]},${H - PY} L${pts[0][0]},${H - PY} Z`} fill={`url(#${gid})`} />
      <path className="__bi_line_path" d={curve} fill="none" stroke={c1} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Chart: Number (KPI) ─────────────────────────────────────────────────────

function NumberCard(props: { data: any[]; measure?: string }) {
  const curr = props.data.length > 0 ? Number(props.data[0][props.measure ?? "value"] ?? props.data[0].value ?? 0) : 0;
  const prev = props.data.length > 1 ? Number(props.data[1][props.measure ?? "value"] ?? props.data[1].value ?? 0) : null;
  const delta = prev != null && prev !== 0 ? ((curr - prev) / prev) * 100 : null;
  const up = delta != null && delta >= 0;
  return (
    <div className="__bi_kpi_num" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 110, gap: 6 }}>
      <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.02em", background: "linear-gradient(135deg, #6366f1, #0ea5e9)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
        {curr.toLocaleString()}
      </span>
      {delta != null && (
        <span style={{
          fontSize: 12, fontWeight: 600,
          color: up ? "#10b981" : "#ef4444",
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 10px", borderRadius: 20,
          background: up ? "rgba(16,185,129,.08)" : "rgba(239,68,68,.08)",
        }}>
          <span style={{ fontSize: 10 }}>{up ? "▲" : "▼"}</span>
          {Math.abs(delta).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

// ─── Chart: Pie ──────────────────────────────────────────────────────────────

function PieChart(props: { data: any[]; measure?: string; donut?: boolean }) {
  const values = extractValues(props.data.slice(0, 8), props.measure);
  const total = values.reduce((s, v) => s + v.value, 0);
  const R = 1, IR = props.donut ? 0.6 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 0" }}>
      <svg viewBox="-1.15 -1.15 2.3 2.3" style={{ width: 110, height: 110, flexShrink: 0, overflow: "visible" }}>
        {values.map((v, i) => {
          const cumBefore = values.slice(0, i).reduce((s, x) => s + x.value, 0);
          const start = cumBefore / total, end = (cumBefore + v.value) / total;
          const gap = 0.006;
          const s = start + gap, e = end - gap;
          if (e <= s) return null;
          const largeArc = e - s > 0.5 ? 1 : 0;
          const [c1] = pal(i);
          const x1 = Math.cos(2 * Math.PI * s) * R, y1 = Math.sin(2 * Math.PI * s) * R;
          const x2 = Math.cos(2 * Math.PI * e) * R, y2 = Math.sin(2 * Math.PI * e) * R;
          const ix1 = Math.cos(2 * Math.PI * s) * IR, iy1 = Math.sin(2 * Math.PI * s) * IR;
          const ix2 = Math.cos(2 * Math.PI * e) * IR, iy2 = Math.sin(2 * Math.PI * e) * IR;
          const d = IR > 0
            ? `M${ix1},${iy1} L${x1},${y1} A${R},${R} 0 ${largeArc} 1 ${x2},${y2} L${ix2},${iy2} A${IR},${IR} 0 ${largeArc} 0 ${ix1},${iy1} Z`
            : `M${x1},${y1} A${R},${R} 0 ${largeArc} 1 ${x2},${y2} L0,0 Z`;
          return <path key={i} className="__bi_slice" d={d} fill={c1} style={{ transform: "rotate(-90deg)", transformOrigin: "center", animationDelay: `${i * 0.07}s`, filter: `drop-shadow(0 1px 3px ${c1}44)` }} />;
        })}
        {props.donut && (
          <text x="0" y="0.1" textAnchor="middle" fontSize="0.36" fontWeight="800" fill="var(--sl-fg,#1e293b)" style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}>
            {total.toLocaleString()}
          </text>
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        {values.map((v, i) => {
          const [c1] = pal(i);
          const pct = Math.round((v.value / total) * 100);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: c1, flexShrink: 0 }} />
              <span style={{ color: "var(--sl-fg, #1e293b)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.label}</span>
              <span style={{ color: "var(--sl-muted, #94a3b8)", fontWeight: 600, marginLeft: "auto" }}>{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chart: Gauge ────────────────────────────────────────────────────────────

function GaugeChart(props: { data: any[]; measure?: string; uid?: string }) {
  const value = props.data.length > 0 ? Number(props.data[0][props.measure ?? "value"] ?? props.data[0].value ?? 0) : 0;
  const maxVal = props.data.length > 1 ? Number(props.data[1]?.max ?? 100) : 100;
  const pct = Math.min(Math.max(value / maxVal, 0), 1);
  const R = 40, CX = 50, CY = 52;
  const startAngle = Math.PI * 0.75, endAngle = Math.PI * 2.25;
  const sweep = (endAngle - startAngle) * pct;
  const totalArcLen = (endAngle - startAngle) * R;
  const arcOffset = totalArcLen * (1 - pct);
  const ex = CX + R * Math.cos(startAngle + sweep), ey = CY + R * Math.sin(startAngle + sweep);
  const bx1 = CX + R * Math.cos(startAngle), by1 = CY + R * Math.sin(startAngle);
  const bx2 = CX + R * Math.cos(endAngle), by2 = CY + R * Math.sin(endAngle);
  const [c1, c2] = pal(0);
  const gid = `gaugeG_${props.uid ?? ""}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 8 }}>
      <svg viewBox="0 0 100 75" style={{ width: 140, height: 105, overflow: "visible" }}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={c1} /><stop offset="100%" stopColor={c2} /></linearGradient></defs>
        <path d={`M${bx1},${by1} A${R},${R} 0 1 1 ${bx2},${by2}`} fill="none" stroke="var(--sl-border, #e5e7eb)" strokeWidth="8" strokeLinecap="round" />
        <path d={`M${bx1},${by1} A${R},${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${ex},${ey}`} fill="none" stroke={`url(#${gid})`} strokeWidth="8" strokeLinecap="round" className="__bi_gauge_arc" style={{ ["--gauge-offset" as any]: arcOffset, filter: `drop-shadow(0 0 6px ${c1}55)` }} />
        <text x={CX} y={CY} textAnchor="middle" fontSize="16" fontWeight="800" fill="var(--sl-fg, #1e293b)">{value}</text>
        <text x={CX} y={CY + 13} textAnchor="middle" fontSize="8" fill="var(--sl-muted, #94a3b8)">/ {maxVal}</text>
        <text x={CX} y={CY + 23} textAnchor="middle" fontSize="7" fontWeight="600" fill={c1}>{Math.round(pct * 100)}%</text>
      </svg>
    </div>
  );
}

// ─── Chart: Sparkline ────────────────────────────────────────────────────────

function SparklineChart(props: { data: any[]; measure?: string; uid?: string }) {
  const values = extractValues(props.data.slice(0, 30), props.measure);
  const nums = values.map((v) => v.value);
  const max = Math.max(...nums, 1), min = Math.min(...nums, 0);
  const W = 200, H = 50;
  const pts = nums.map((v, i) => [i / Math.max(nums.length - 1, 1) * W, H - 4 - ((v - min) / (max - min || 1)) * (H - 8)]);
  const curve = bezierSmooth(pts);
  const last = nums[nums.length - 1], first = nums[0];
  const up = last >= first;
  const c = up ? "#10b981" : "#ef4444";
  const gid = `sparkG_${props.uid ?? ""}`;
  const lastPt = pts[pts.length - 1];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "12px 0" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 56, overflow: "visible" }}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity="0.2" /><stop offset="100%" stopColor={c} stopOpacity="0" /></linearGradient></defs>
        <path className="__bi_area_fill" d={`${curve} L${lastPt[0]},${H} L0,${H} Z`} fill={`url(#${gid})`} />
        <path className="__bi_spark_path" d={curve} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
        <circle className="__bi_pulse" cx={lastPt[0]} cy={lastPt[1]} r="3" fill={c} />
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
        <span style={{ color: "var(--sl-muted)" }}>Low <b style={{ color: "var(--sl-fg)" }}>{min.toLocaleString()}</b></span>
        <span style={{ color: "var(--sl-muted)" }}>High <b style={{ color: "var(--sl-fg)" }}>{max.toLocaleString()}</b></span>
        <span style={{ color: c, fontWeight: 600, padding: "1px 8px", borderRadius: 10, background: up ? "rgba(16,185,129,.08)" : "rgba(239,68,68,.08)" }}>{up ? "▲" : "▼"} {last.toLocaleString()}</span>
      </div>
    </div>
  );
}

// ─── Chart: Table ────────────────────────────────────────────────────────────

function SimpleTable(props: { data: any[]; locale?: string }) {
  if (props.data.length === 0) return <div style={{ color: "var(--sl-muted)", textAlign: "center", padding: 16 }}>{t(props.locale, "widget.noData")}</div>;
  const cols = Object.keys(props.data[0]).slice(0, 8);
  return (
    <div style={{ overflow: "auto", maxHeight: 220 }}>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "separate", borderSpacing: 0 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "6px 8px", borderBottom: "2px solid var(--sl-border, #e5e7eb)", fontWeight: 700, fontSize: 11, color: "var(--sl-muted, #64748b)", textTransform: "uppercase", letterSpacing: "0.04em", position: "sticky", top: 0, background: "var(--sl-surface, #fff)" }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.data.slice(0, 30).map((row, i) => (
            <tr key={i} className="__bi_tbl_row">
              {cols.map((c) => (
                <td key={c} style={{ padding: "5px 8px", borderBottom: "1px solid var(--sl-border, #f1f5f9)", color: "var(--sl-fg, #1e293b)" }}>{String(row[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Card Component ─────────────────────────────────────────────────────────

function DashboardCard(props: {
  card: MetricCard;
  data: any[];
  readOnly: boolean;
  locale?: string;
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<MetricCard>) => void;
}) {
  const { card, data, readOnly, locale, onRemove, onUpdate } = props;
  const uid = useId().replace(/:/g, "_");

  const chartNode = useMemo(() => {
    switch (card.chartType) {
      case "bar": return <BarChart data={data} measure={card.measures?.[0]} />;
      case "line": return <LineChart data={data} measure={card.measures?.[0]} uid={uid} />;
      case "area": return <AreaChart data={data} measure={card.measures?.[0]} uid={uid} />;
      case "number": return <NumberCard data={data} measure={card.measures?.[0]} />;
      case "pie": return <PieChart data={data} measure={card.measures?.[0]} />;
      case "donut": return <PieChart data={data} measure={card.measures?.[0]} donut />;
      case "gauge": return <GaugeChart data={data} measure={card.measures?.[0]} uid={uid} />;
      case "sparkline": return <SparklineChart data={data} measure={card.measures?.[0]} uid={uid} />;
      case "table": return <SimpleTable data={data} locale={locale} />;
      default: return <div>{t(locale, "widget.unknownChartType")}</div>;
    }
  }, [card.chartType, card.measures, data, locale, uid]);

  const cardStyle: React.CSSProperties = {
    border: "1px solid var(--sl-border, #e5e7eb)",
    borderRadius: 14,
    background: "var(--sl-surface, #fff)",
    padding: 16,
    minWidth: 260,
    flex: "1 1 300px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    position: "relative",
    overflow: "hidden",
  };

  const chartTypeLabels: Record<ChartType, string> = {
    bar: "📊 Bar", line: "📈 Line", area: "🏔️ Area", pie: "🥧 Pie", donut: "🍩 Donut",
    number: "🔢 KPI", gauge: "⏱️ Gauge", sparkline: "⚡ Spark", table: "📋 Table",
  };

  return (
    <div className="__bi_card" style={cardStyle}>
      {/* subtle top accent */}
      <div className="__bi_accent" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #6366f1, #0ea5e9, #10b981)", borderRadius: "14px 14px 0 0", opacity: 0.4, transition: "opacity 0.3s" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, paddingTop: 2 }}>
        {readOnly ? (
          <strong style={{ fontSize: 13, fontWeight: 700, color: "var(--sl-fg, #1e293b)" }}>{card.title}</strong>
        ) : (
          <input
            value={card.title}
            onChange={(e) => onUpdate(card.id, { title: e.target.value })}
            style={{ fontSize: 13, fontWeight: 700, border: "none", background: "transparent", color: "var(--sl-fg, #1e293b)", flex: 1, outline: "none" }}
          />
        )}
        {!readOnly && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select
              value={card.chartType}
              onChange={(e) => onUpdate(card.id, { chartType: e.target.value as ChartType })}
              style={{ fontSize: 10, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)", color: "var(--sl-fg)", cursor: "pointer" }}
            >
              {Object.entries(chartTypeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button onClick={() => onRemove(card.id)} style={{ fontSize: 12, cursor: "pointer", background: "none", border: "none", color: "var(--sl-danger, #ef4444)", lineHeight: 1, padding: 2 }} title="Remove">✕</button>
          </div>
        )}
      </div>
      {chartNode}
    </div>
  );
}

// ─── BI Dashboard Widget ────────────────────────────────────────────────────

export function BiDashboardWidget(props: BiDashboardProps) {
  const { cards, onChange, readOnly = false, data = {} } = props;

  const handleRemove = useCallback((id: string) => onChange(cards.filter((c) => c.id !== id)), [cards, onChange]);
  const handleUpdate = useCallback(
    (id: string, updates: Partial<MetricCard>) => onChange(cards.map((c) => (c.id === id ? { ...c, ...updates } : c))),
    [cards, onChange],
  );
  const handleAdd = useCallback(
    (type: ChartType) => onChange([...cards, createCard(type, `New ${type} chart`)]),
    [cards, onChange],
  );

  const sampleData = [
    { label: "Q1", value: 42 },
    { label: "Q2", value: 58 },
    { label: "Q3", value: 35 },
    { label: "Q4", value: 70 },
    { label: "Q5", value: 52 },
  ];

  const chartGroups: { label: string; types: ChartType[] }[] = [
    { label: "Charts", types: ["bar", "line", "area", "pie", "donut"] },
    { label: "KPI", types: ["number", "gauge", "sparkline"] },
    { label: "Data", types: ["table"] },
  ];

  const btnStyle: React.CSSProperties = {
    padding: "5px 12px",
    fontSize: 11,
    fontWeight: 500,
    border: "1px solid var(--sl-border, #e5e7eb)",
    borderRadius: 8,
    background: "var(--sl-surface, #fff)",
    color: "var(--sl-fg, #1e293b)",
    cursor: "pointer",
    transition: "all 0.15s",
  };

  return (
    <div>
      <style>{BI_CSS}</style>
      {!readOnly && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {chartGroups.map((g) => (
            <div key={g.label} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--sl-muted, #94a3b8)", textTransform: "uppercase", letterSpacing: "0.05em", marginRight: 2 }}>{g.label}</span>
              {g.types.map((ct) => (
                <button key={ct} style={btnStyle} onClick={() => handleAdd(ct)}>+ {ct}</button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {cards.map((card) => (
          <DashboardCard
            key={card.id}
            card={card}
            data={data[card.metricName ?? card.id] ?? sampleData}
            readOnly={readOnly}
            locale={props.locale}
            onRemove={handleRemove}
            onUpdate={handleUpdate}
          />
        ))}
      </div>
      {cards.length === 0 && (
        <div style={{
          padding: 48, textAlign: "center", color: "var(--sl-muted, #94a3b8)",
          border: "2px dashed var(--sl-border, #e5e7eb)", borderRadius: 16,
          background: "linear-gradient(135deg, rgba(99,102,241,0.02), rgba(14,165,233,0.02))",
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--sl-fg, #475569)" }}>
            {readOnly ? t(props.locale, "widget.noDashboardCards") : t(props.locale, "widget.addChartHint")}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Bar · Line · Area · Pie · Donut · KPI · Gauge · Sparkline · Table</div>
        </div>
      )}
    </div>
  );
}

export default BiDashboardWidget;
