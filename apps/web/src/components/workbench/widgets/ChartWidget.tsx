"use client";

import { useMemo, useId } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SimpleChartType = "bar" | "line" | "pie";

export interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface ChartWidgetProps {
  chartType: SimpleChartType;
  data: ChartDataPoint[];
  title?: string;
  width?: number;
  height?: number;
  locale?: string;
}

// ─── Palette ─────────────────────────────────────────────────────────────────

const CHART_COLORS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#06b6d4",
];
const CHART_COLORS_LIGHT = [
  "#e0e7ff", "#e0f2fe", "#d1fae5", "#fef3c7", "#fee2e2",
  "#ede9fe", "#fce7f3", "#ccfbf1", "#ffedd5", "#cffafe",
];

// ─── Tooltip (pure CSS, zero-JS) ─────────────────────────────────────────────

function Tooltip({ x, y, label, value, pct }: { x: number; y: number; label: string; value: number; pct?: string }) {
  return (
    <g className="__cw_tip" style={{ pointerEvents: "none" }}>
      <rect x={x - 48} y={y - 38} width={96} height={30} rx={8} fill="#1e293b" opacity={0.92} />
      <polygon points={`${x - 5},${y - 8} ${x + 5},${y - 8} ${x},${y - 2}`} fill="#1e293b" opacity={0.92} />
      <text x={x} y={y - 20} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
        {label}: {value.toLocaleString()}{pct ? ` (${pct}%)` : ""}
      </text>
    </g>
  );
}

// ─── Shared CSS (injected once) ──────────────────────────────────────────────

const CHART_CSS = `
.__cw svg{width:100%;height:auto;overflow:visible}
.__cw_bar{transition:height .5s cubic-bezier(.4,0,.2,1),y .5s cubic-bezier(.4,0,.2,1),opacity .4s;opacity:0;animation:__cwFadeUp .5s ease-out forwards}
.__cw_bar:hover{filter:brightness(1.12);transform-origin:bottom center}
.__cw_line_path{stroke-dasharray:1000;stroke-dashoffset:1000;animation:__cwDraw 1.2s ease-out forwards}
.__cw_area{opacity:0;animation:__cwFadeIn .8s .3s ease-out forwards}
.__cw_dot{opacity:0;animation:__cwPop .3s ease-out forwards;transition:r .15s,filter .15s}
.__cw_dot:hover{r:6;filter:drop-shadow(0 0 6px var(--dot-c,#6366f1))}
.__cw_slice{opacity:0;transform-origin:center;animation:__cwSliceIn .6s ease-out forwards;transition:transform .2s,filter .2s}
.__cw_slice:hover{transform:scale(1.04);filter:brightness(1.1) drop-shadow(0 2px 8px rgba(0,0,0,.18))}
.__cw_tip{opacity:0;transition:opacity .15s}
.__cw_bar:hover+.__cw_tip,.__cw_dot:hover~.__cw_tip,.__cw_slice:hover+.__cw_tip{opacity:1}
.__cw_gridline{stroke:var(--sl-border,#e5e7eb);stroke-width:.5;stroke-dasharray:4 3}
@keyframes __cwFadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes __cwFadeIn{to{opacity:1}}
@keyframes __cwDraw{to{stroke-dashoffset:0}}
@keyframes __cwPop{from{opacity:0;r:0}to{opacity:1}}
@keyframes __cwSliceIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
`;

// ─── Bar Chart (SVG) ─────────────────────────────────────────────────────────

function BarChart({ data, W, H, uid }: { data: ChartDataPoint[]; W: number; H: number; uid: string }) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const PL = 38, PB = 32, PT = 8;
  const chartW = W - PL - 8;
  const chartH = H - PB - PT;
  const gap = Math.max(4, Math.min(10, chartW / data.length * 0.2));
  const barW = Math.max(8, (chartW - gap * (data.length + 1)) / data.length);
  const gridLines = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="bar chart">
      <defs>
        {data.map((d, i) => {
          const c = d.color || CHART_COLORS[i % CHART_COLORS.length];
          const cl = CHART_COLORS_LIGHT[i % CHART_COLORS_LIGHT.length];
          return <linearGradient key={i} id={`${uid}_bg${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} /><stop offset="100%" stopColor={cl} stopOpacity={0.6} /></linearGradient>;
        })}
      </defs>
      {/* Grid lines */}
      {gridLines.map((r) => {
        const y = PT + chartH * (1 - r);
        return <line key={r} x1={PL} y1={y} x2={W - 8} y2={y} className="__cw_gridline" />;
      })}
      {/* Y axis labels */}
      {gridLines.map((r) => (
        <text key={`y${r}`} x={PL - 6} y={PT + chartH * (1 - r) + 3} fontSize={9} fill="#94a3b8" textAnchor="end">
          {Math.round(maxVal * r).toLocaleString()}
        </text>
      ))}
      {/* Bars + labels + tooltips */}
      {data.map((d, i) => {
        const c = d.color || CHART_COLORS[i % CHART_COLORS.length];
        const barH = Math.max(2, (d.value / maxVal) * chartH);
        const x = PL + gap + i * (barW + gap);
        const y = PT + chartH - barH;
        return (
          <g key={i}>
            <rect className="__cw_bar" x={x} y={y} width={barW} height={barH} rx={barW > 16 ? 6 : 3} fill={`url(#${uid}_bg${i})`} style={{ animationDelay: `${i * 60}ms` }}>
            </rect>
            <Tooltip x={x + barW / 2} y={y} label={d.label} value={d.value} />
            {/* value on top */}
            <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={9} fontWeight={600} fill={c} opacity={0.8}>{d.value.toLocaleString()}</text>
            {/* X label */}
            <text x={x + barW / 2} y={H - 8} fontSize={9} fill="#64748b" textAnchor="middle">
              {d.label.length > 6 ? `${d.label.slice(0, 6)}…` : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Line Chart (SVG) — bezier smooth ────────────────────────────────────────

function bezierPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const parts: string[] = [`M${points[0].x},${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const tension = 0.3;
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    parts.push(`C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`);
  }
  return parts.join(" ");
}

function LineChart({ data, W, H, uid }: { data: ChartDataPoint[]; W: number; H: number; uid: string }) {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const PL = 38, PB = 32, PT = 12;
  const chartH = H - PB - PT;
  const chartW = W - PL - 12;
  const stepX = data.length > 1 ? chartW / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: PL + i * stepX,
    y: PT + chartH - (d.value / maxVal) * chartH,
  }));

  const curve = bezierPath(points);
  const lastPt = points[points.length - 1] ?? { x: PL, y: PT + chartH };
  const firstPt = points[0] ?? { x: PL, y: PT + chartH };
  const areaPath = `${curve} L${lastPt.x},${PT + chartH} L${firstPt.x},${PT + chartH} Z`;
  const gridLines = [0.25, 0.5, 0.75, 1];
  const c = data[0]?.color || "#6366f1";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="line chart">
      <defs>
        <linearGradient id={`${uid}_areaG`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity={0.18} />
          <stop offset="100%" stopColor={c} stopOpacity={0.01} />
        </linearGradient>
      </defs>
      {/* Grid */}
      {gridLines.map((r) => {
        const y = PT + chartH * (1 - r);
        return <line key={r} x1={PL} y1={y} x2={W - 12} y2={y} className="__cw_gridline" />;
      })}
      {gridLines.map((r) => (
        <text key={`y${r}`} x={PL - 6} y={PT + chartH * (1 - r) + 3} fontSize={9} fill="#94a3b8" textAnchor="end">{Math.round(maxVal * r).toLocaleString()}</text>
      ))}
      {/* Area fill */}
      <path d={areaPath} fill={`url(#${uid}_areaG)`} className="__cw_area" />
      {/* Smooth line */}
      <path d={curve} fill="none" stroke={c} strokeWidth={2.5} strokeLinecap="round" className="__cw_line_path" />
      {/* Dots + tooltips + labels */}
      {points.map((p, i) => (
        <g key={i}>
          <circle className="__cw_dot" cx={p.x} cy={p.y} r={4} fill="#fff" stroke={c} strokeWidth={2} style={{ animationDelay: `${0.4 + i * 0.06}s`, ["--dot-c" as any]: c }} />
          <Tooltip x={p.x} y={p.y - 6} label={data[i].label} value={data[i].value} />
          <text x={p.x} y={H - 8} fontSize={9} fill="#64748b" textAnchor="middle">
            {data[i].label.length > 6 ? `${data[i].label.slice(0, 6)}…` : data[i].label}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ─── Pie / Donut Chart (SVG) ─────────────────────────────────────────────────

function PieChart({ data, W, H, donut }: { data: ChartDataPoint[]; W: number; H: number; donut?: boolean }) {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  const legendH = Math.min(data.length, 6) * 18 + 8;
  const chartArea = Math.min(W, H - legendH);
  const cx = W / 2;
  const cy = (H - legendH) / 2;
  const R = chartArea / 2 - 16;
  const IR = donut ? R * 0.58 : 0;

  const startAngle0 = -Math.PI / 2;
  const fracs = data.map((d) => d.value / total);
  const cumulative = fracs.reduce<number[]>((acc, f) => acc.length ? acc.concat(acc[acc.length - 1] + f) : acc.concat(f), []);
  const slices = data.map((d, i) => {
    const pct = fracs[i] ?? 0;
    const prev = i === 0 ? 0 : (cumulative[i - 1] ?? 0);
    const end = cumulative[i] ?? 0;
    const baseStart = startAngle0 + prev * 2 * Math.PI;
    const baseEnd = startAngle0 + end * 2 * Math.PI;
    const gap = 0.015;
    const s = baseStart + gap;
    const e = baseEnd - gap;
    const largeArc = (e - s) > Math.PI ? 1 : 0;
    const x1 = cx + R * Math.cos(s), y1 = cy + R * Math.sin(s);
    const x2 = cx + R * Math.cos(e), y2 = cy + R * Math.sin(e);
    let path: string;
    if (IR > 0) {
      const ix1 = cx + IR * Math.cos(s), iy1 = cy + IR * Math.sin(s);
      const ix2 = cx + IR * Math.cos(e), iy2 = cy + IR * Math.sin(e);
      path = `M${ix1},${iy1} L${x1},${y1} A${R},${R} 0 ${largeArc} 1 ${x2},${y2} L${ix2},${iy2} A${IR},${IR} 0 ${largeArc} 0 ${ix1},${iy1} Z`;
    } else {
      path = `M${cx},${cy} L${x1},${y1} A${R},${R} 0 ${largeArc},1 ${x2},${y2} Z`;
    }
    const color = d.color || CHART_COLORS[i % CHART_COLORS.length];
    const midAngle = (s + e) / 2;
    const tipR = R * 0.7;
    return { path, color, label: d.label, value: d.value, pct: (pct * 100).toFixed(1), tipX: cx + tipR * Math.cos(midAngle), tipY: cy + tipR * Math.sin(midAngle), delay: i * 0.08 };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="pie chart">
      {/* Drop shadow for depth */}
      <defs>
        <filter id="__cwPieSh"><feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.1" /></filter>
      </defs>
      {slices.map((s, i) => (
        <g key={i}>
          <path d={s.path} fill={s.color} className="__cw_slice" style={{ animationDelay: `${s.delay}s`, filter: "url(#__cwPieSh)" }} />
          <Tooltip x={s.tipX} y={s.tipY - 6} label={s.label} value={s.value} pct={s.pct} />
        </g>
      ))}
      {/* Donut center text */}
      {donut && (
        <>
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize={18} fontWeight={800} fill="var(--sl-fg,#1e293b)">{total.toLocaleString()}</text>
          <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} fill="#94a3b8">total</text>
        </>
      )}
      {/* Legend */}
      {data.slice(0, 6).map((d, i) => {
        const c = d.color || CHART_COLORS[i % CHART_COLORS.length];
        const ly = H - legendH + 8 + i * 18;
        return (
          <g key={i}>
            <rect x={W / 2 - 80} y={ly} width={10} height={10} rx={3} fill={c} />
            <text x={W / 2 - 64} y={ly + 9} fontSize={11} fill="var(--sl-fg,#475569)">
              {d.label.length > 14 ? `${d.label.slice(0, 14)}…` : d.label}
            </text>
            <text x={W / 2 + 80} y={ly + 9} textAnchor="end" fontSize={10} fontWeight={600} fill="#94a3b8">
              {slices[i]?.pct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ChartWidget(props: ChartWidgetProps) {
  const { chartType, data, title, width = 400, height = 260, locale: _locale = "zh-CN" } = props;
  void _locale;
  const uid = useId().replace(/:/g, "_");

  const coloredData = useMemo(
    () => data.map((d, i) => ({ ...d, color: d.color || CHART_COLORS[i % CHART_COLORS.length] })),
    [data],
  );

  if (!data.length) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
        <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.5 }}>📊</div>
        No chart data
      </div>
    );
  }

  return (
    <div className="__cw" style={{ padding: "8px 4px" }}>
      <style>{CHART_CSS}</style>
      {title && (
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, padding: "0 8px", color: "var(--sl-fg, #1e293b)", display: "flex", alignItems: "center", gap: 8 }}>
          {title}
          <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 400 }}>{data.length} items</span>
        </div>
      )}
      {chartType === "bar" && <BarChart data={coloredData} W={width} H={height} uid={uid} />}
      {chartType === "line" && <LineChart data={coloredData} W={width} H={height} uid={uid} />}
      {chartType === "pie" && <PieChart data={coloredData} W={width} H={height} />}
    </div>
  );
}

export default ChartWidget;
