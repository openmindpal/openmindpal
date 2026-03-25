"use client";

import { useState, useCallback, useRef, useMemo } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type FlowNodeType = "start" | "end" | "action" | "condition" | "parallel" | "wait" | "llm" | "tool" | "human" | "webhook" | "timer" | "subflow";

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  label: string;
  x: number;
  y: number;
  meta?: Record<string, any>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
}

export interface FlowCanvasProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onNodesChange: (nodes: FlowNode[]) => void;
  onEdgesChange: (edges: FlowEdge[]) => void;
  readOnly?: boolean;
  locale?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _nodeIdCounter = 0;
function genId(prefix: string): string { return `${prefix}_${Date.now()}_${++_nodeIdCounter}`; }

const NODE_COLORS: Record<FlowNodeType, [string, string]> = {
  start:    ["#22c55e", "#86efac"],
  end:      ["#ef4444", "#fca5a5"],
  action:   ["#3b82f6", "#93c5fd"],
  condition:["#f59e0b", "#fcd34d"],
  parallel: ["#8b5cf6", "#c4b5fd"],
  wait:     ["#6b7280", "#d1d5db"],
  llm:      ["#06b6d4", "#67e8f9"],
  tool:     ["#f97316", "#fdba74"],
  human:    ["#ec4899", "#f9a8d4"],
  webhook:  ["#14b8a6", "#5eead4"],
  timer:    ["#a855f7", "#d8b4fe"],
  subflow:  ["#0284c7", "#7dd3fc"],
};

const NODE_ICONS: Record<FlowNodeType, string> = {
  start: "▶", end: "■", action: "⚡", condition: "◇", parallel: "≡",
  wait: "⏳", llm: "🤖", tool: "🔧", human: "👤", webhook: "🔔",
  timer: "⏰", subflow: "↩",
};

function nodeShape(type: FlowNodeType): "circle" | "diamond" | "rect" | "hexagon" {
  if (type === "start" || type === "end") return "circle";
  if (type === "condition") return "diamond";
  if (type === "parallel") return "hexagon";
  return "rect";
}

// ─── Bezier Edge ────────────────────────────────────────────────────────────

function BezierEdge(props: { edge: FlowEdge; src: FlowNode; tgt: FlowNode; selected: boolean; onSelect: (id: string) => void }) {
  const { edge, src, tgt, selected, onSelect } = props;
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const cx = Math.abs(dx) * 0.5;
  const cy = Math.abs(dy) * 0.3;
  // smooth bezier
  const path = `M${src.x},${src.y} C${src.x + cx},${src.y + cy} ${tgt.x - cx},${tgt.y - cy} ${tgt.x},${tgt.y}`;
  const midX = (src.x + tgt.x) / 2;
  const midY = (src.y + tgt.y) / 2;

  return (
    <g onClick={(e) => { e.stopPropagation(); onSelect(edge.id); }} style={{ cursor: "pointer" }}>
      {/* invisible wider hit area */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
      {/* visible line */}
      <path d={path} fill="none"
        stroke={selected ? "#6366f1" : "var(--sl-muted, #94a3b8)"}
        strokeWidth={selected ? 2.5 : 1.8}
        strokeDasharray={edge.condition ? "6 3" : "none"}
        markerEnd="url(#arrowV2)"
        style={{ transition: "stroke 0.2s" }}
      />
      {/* animated dot */}
      <circle r="2.5" fill="#6366f1" opacity={selected ? 0.8 : 0}>
        <animateMotion dur="1.5s" repeatCount="indefinite" path={path} />
      </circle>
      {edge.label && (
        <g transform={`translate(${midX}, ${midY - 8})`}>
          <rect x={-edge.label.length * 3.5 - 6} y={-9} width={edge.label.length * 7 + 12} height={18} rx={9} fill="var(--sl-surface, #fff)" stroke="var(--sl-border, #e5e7eb)" strokeWidth="0.8" />
          <text textAnchor="middle" dy="4" fontSize="9" fontWeight="500" fill="var(--sl-fg, #475569)">{edge.label}</text>
        </g>
      )}
    </g>
  );
}

// ─── SVG Node ───────────────────────────────────────────────────────────────

function SvgNode(props: {
  node: FlowNode; selected: boolean; readOnly: boolean;
  onSelect: (id: string) => void;
  onDragStart: (id: string, e: React.MouseEvent) => void;
}) {
  const { node, selected, readOnly, onSelect, onDragStart } = props;
  const [c1] = NODE_COLORS[node.type] ?? ["#6b7280"];
  const shape = nodeShape(node.type);
  const icon = NODE_ICONS[node.type] ?? "⚡";

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(node.id);
    if (!readOnly) onDragStart(node.id, e);
  };

  const shadow = selected ? `drop-shadow(0 0 8px ${c1}66)` : `drop-shadow(0 2px 4px ${c1}33)`;

  return (
    <g transform={`translate(${node.x}, ${node.y})`} onMouseDown={handleMouseDown} style={{ cursor: readOnly ? "default" : "grab" }}>
      {/* glow when selected */}
      {selected && shape === "circle" && <circle r={30} fill={c1} opacity={0.1} />}
      {selected && shape === "rect" && <rect x={-58} y={-26} width={116} height={52} rx={14} fill={c1} opacity={0.1} />}

      {shape === "circle" && (
        <circle r={24} fill={`url(#grad_${node.type})`} stroke={selected ? c1 : "transparent"} strokeWidth={2} style={{ filter: shadow }} />
      )}
      {shape === "diamond" && (
        <polygon points="0,-30 34,0 0,30 -34,0" fill={`url(#grad_${node.type})`} stroke={selected ? c1 : "transparent"} strokeWidth={2} style={{ filter: shadow }} />
      )}
      {shape === "rect" && (
        <rect x={-54} y={-22} width={108} height={44} rx={10} fill={`url(#grad_${node.type})`} stroke={selected ? c1 : "transparent"} strokeWidth={2} style={{ filter: shadow }} />
      )}
      {shape === "hexagon" && (
        <polygon points="-40,-20 -20,-32 20,-32 40,-20 40,20 20,32 -20,32 -40,20" fill={`url(#grad_${node.type})`} stroke={selected ? c1 : "transparent"} strokeWidth={2} style={{ filter: shadow }} />
      )}

      {/* icon badge */}
      {shape === "rect" && (
        <g transform="translate(-42, -10)">
          <circle r={10} fill="#fff" opacity={0.25} />
          <text textAnchor="middle" dy="4" fontSize="10">{icon}</text>
        </g>
      )}

      <text textAnchor="middle" dy={shape === "rect" ? "5" : "4"} fontSize="11" fill="#fff" fontWeight="600" pointerEvents="none"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}>
        {node.label.length > 10 ? node.label.slice(0, 9) + "…" : node.label}
      </text>
    </g>
  );
}

// ─── Flow Canvas Widget ─────────────────────────────────────────────────────

export function FlowCanvasWidget(props: FlowCanvasProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, readOnly = false } = props;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragRef = useRef<{ nodeId: string; startX: number; startY: number; nodeStartX: number; nodeStartY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; panStartX: number; panStartY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const handleDragStart = useCallback((nodeId: string, e: React.MouseEvent) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    dragRef.current = { nodeId, startX: e.clientX, startY: e.clientY, nodeStartX: node.x, nodeStartY: node.y };
  }, [nodeMap]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current && !readOnly) {
      const { nodeId, startX, startY, nodeStartX, nodeStartY } = dragRef.current;
      const dx = (e.clientX - startX) / zoom;
      const dy = (e.clientY - startY) / zoom;
      onNodesChange(nodes.map((n) => (n.id === nodeId ? { ...n, x: nodeStartX + dx, y: nodeStartY + dy } : n)));
    } else if (panRef.current) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setPan({ x: panRef.current.panStartX + dx, y: panRef.current.panStartY + dy });
    }
  }, [nodes, onNodesChange, readOnly, zoom]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    panRef.current = null;
    setIsPanning(false);
  }, []);

  const handleBgMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === svgRef.current || (e.target as SVGElement).tagName === "rect") {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      panRef.current = { startX: e.clientX, startY: e.clientY, panStartX: pan.x, panStartY: pan.y };
      setIsPanning(true);
    }
  }, [pan]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(Math.max(z - e.deltaY * 0.001, 0.3), 3));
  }, []);

  const handleAddNode = useCallback((type: FlowNodeType) => {
    const x = 100 + Math.random() * 500;
    const y = 60 + Math.random() * 350;
    const labels: Record<FlowNodeType, string> = {
      start: "Start", end: "End", action: "Action", condition: "If/Else",
      parallel: "Parallel", wait: "Wait", llm: "LLM Call", tool: "Tool",
      human: "Human", webhook: "Webhook", timer: "Timer", subflow: "Sub-flow",
    };
    onNodesChange([...nodes, { id: genId("n"), type, label: labels[type], x, y }]);
  }, [nodes, onNodesChange]);

  const handleRemoveNode = useCallback((id: string) => {
    onNodesChange(nodes.filter((n) => n.id !== id));
    onEdgesChange(edges.filter((e) => e.source !== id && e.target !== id));
    setSelectedNodeId(null);
  }, [nodes, edges, onNodesChange, onEdgesChange]);

  const handleRemoveEdge = useCallback((id: string) => {
    onEdgesChange(edges.filter((e) => e.id !== id));
    setSelectedEdgeId(null);
  }, [edges, onEdgesChange]);

  const handleConnectToggle = useCallback(() => {
    setConnectMode(!connectMode); setConnectSource(null);
  }, [connectMode]);

  const handleNodeSelect = useCallback((id: string) => {
    setSelectedEdgeId(null);
    if (connectMode) {
      if (!connectSource) { setConnectSource(id); }
      else if (connectSource !== id) {
        if (!edges.some((e) => e.source === connectSource && e.target === id)) {
          onEdgesChange([...edges, { id: genId("e"), source: connectSource, target: id }]);
        }
        setConnectSource(null); setConnectMode(false);
      }
    } else { setSelectedNodeId(id); }
  }, [connectMode, connectSource, edges, onEdgesChange]);

  const handleEdgeSelect = useCallback((id: string) => {
    setSelectedNodeId(null);
    setSelectedEdgeId(id);
  }, []);

  const btnStyle: React.CSSProperties = {
    padding: "4px 10px", fontSize: 11, fontWeight: 500,
    border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 7,
    background: "var(--sl-surface, #fff)", color: "var(--sl-fg, #1e293b)",
    cursor: "pointer", transition: "all 0.15s", display: "flex", alignItems: "center", gap: 4,
  };

  const nodeGroups: { label: string; types: FlowNodeType[] }[] = [
    { label: "Flow", types: ["start", "end", "action", "condition", "parallel", "wait"] },
    { label: "AI", types: ["llm", "tool", "human"] },
    { label: "Trigger", types: ["webhook", "timer", "subflow"] },
  ];

  const VW = 900, VH = 550;

  return (
    <div style={{ border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 14, overflow: "hidden", background: "var(--sl-bg, #fafbfc)" }}>
      {/* Toolbar */}
      {!readOnly && (
        <div style={{ display: "flex", gap: 6, padding: "8px 12px", flexWrap: "wrap", borderBottom: "1px solid var(--sl-border, #e5e7eb)", background: "var(--sl-surface, #fff)", alignItems: "center" }}>
          {nodeGroups.map((g) => (
            <div key={g.label} style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--sl-muted, #94a3b8)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{g.label}</span>
              {g.types.map((t) => (
                <button key={t} style={btnStyle} onClick={() => handleAddNode(t)}>
                  <span style={{ fontSize: 11 }}>{NODE_ICONS[t]}</span> {t}
                </button>
              ))}
            </div>
          ))}
          <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
            <button
              style={{ ...btnStyle, background: connectMode ? "#6366f1" : undefined, color: connectMode ? "#fff" : undefined }}
              onClick={handleConnectToggle}
            >
              🔗 {connectMode ? (connectSource ? "Click target" : "Click source") : "Connect"}
            </button>
            {selectedNodeId && (
              <button style={{ ...btnStyle, color: "var(--sl-danger, #ef4444)" }} onClick={() => handleRemoveNode(selectedNodeId)}>🗑️ Node</button>
            )}
            {selectedEdgeId && (
              <button style={{ ...btnStyle, color: "var(--sl-danger, #ef4444)" }} onClick={() => handleRemoveEdge(selectedEdgeId)}>🗑️ Edge</button>
            )}
            <span style={{ fontSize: 10, color: "var(--sl-muted)", padding: "0 4px" }}>{Math.round(zoom * 100)}%</span>
            <button style={{ ...btnStyle, padding: "3px 6px" }} onClick={() => setZoom((z) => Math.min(z + 0.15, 3))}>+</button>
            <button style={{ ...btnStyle, padding: "3px 6px" }} onClick={() => setZoom((z) => Math.max(z - 0.15, 0.3))}>-</button>
            <button style={{ ...btnStyle, padding: "3px 6px" }} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>⟲</button>
          </div>
        </div>
      )}

      {/* Canvas */}
      <svg
        ref={svgRef}
        viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${VW / zoom} ${VH / zoom}`}
        style={{ width: "100%", height: VH, display: "block", cursor: isPanning ? "grabbing" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onMouseDown={handleBgMouseDown}
        onWheel={handleWheel}
      >
        <defs>
          <marker id="arrowV2" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--sl-muted, #94a3b8)" />
          </marker>
          {/* gradients for each node type */}
          {Object.entries(NODE_COLORS).map(([type, [c1, c2]]) => (
            <linearGradient key={type} id={`grad_${type}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c1} />
              <stop offset="100%" stopColor={c2} stopOpacity={0.8} />
            </linearGradient>
          ))}
          {/* grid pattern */}
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--sl-border, #f1f5f9)" strokeWidth="0.5" />
          </pattern>
        </defs>

        {/* Grid background */}
        <rect x={-pan.x / zoom - 100} y={-pan.y / zoom - 100} width={VW / zoom + 200} height={VH / zoom + 200} fill="url(#grid)" />

        {/* Edges */}
        {edges.map((edge) => {
          const src = nodeMap.get(edge.source);
          const tgt = nodeMap.get(edge.target);
          if (!src || !tgt) return null;
          return <BezierEdge key={edge.id} edge={edge} src={src} tgt={tgt} selected={selectedEdgeId === edge.id} onSelect={handleEdgeSelect} />;
        })}

        {/* Nodes */}
        {nodes.map((node) => (
          <SvgNode key={node.id} node={node} selected={selectedNodeId === node.id} readOnly={readOnly}
            onSelect={handleNodeSelect} onDragStart={handleDragStart} />
        ))}
      </svg>

      {/* Minimap */}
      {nodes.length > 0 && (
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${VW} ${VH}`} style={{
            position: "absolute", bottom: 8, right: 8, width: 140, height: 85,
            border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 8,
            background: "var(--sl-surface, rgba(255,255,255,0.9))", boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          }}>
            {edges.map((edge) => {
              const s = nodeMap.get(edge.source), t = nodeMap.get(edge.target);
              if (!s || !t) return null;
              return <line key={edge.id} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#cbd5e1" strokeWidth={2} />;
            })}
            {nodes.map((n) => {
              const [c1] = NODE_COLORS[n.type] ?? ["#6b7280"];
              return <circle key={n.id} cx={n.x} cy={n.y} r={6} fill={c1} />;
            })}
            {/* viewport rect */}
            <rect x={-pan.x / zoom} y={-pan.y / zoom} width={VW / zoom} height={VH / zoom}
              fill="rgba(99,102,241,0.06)" stroke="#6366f1" strokeWidth={3} rx={4} />
          </svg>
        </div>
      )}

      {/* Empty state */}
      {nodes.length === 0 && (
        <div style={{ textAlign: "center", padding: 32, color: "var(--sl-muted, #94a3b8)" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔀</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--sl-fg, #475569)" }}>
            {readOnly ? "No flow defined" : "Add nodes using the toolbar above"}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Start · End · Action · Condition · LLM · Tool · Human · Webhook</div>
        </div>
      )}
    </div>
  );
}

export default FlowCanvasWidget;
