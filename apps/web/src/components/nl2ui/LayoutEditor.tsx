"use client";

import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";

/* ─── Layout model (free-form absolute positioning) ───────────────── */

export interface AreaLayoutItem {
  areaName: string;
  x: number;       // px from container left
  y: number;       // px from container top
  width: number;   // px
  height: number;  // px
}

/* ─── Compute initial positions from variant + container width ─────── */

export function computeInitialPositions(
  containerWidth: number,
  variant: string,
  areas: { name: string }[],
): AreaLayoutItem[] {
  const gap = 16;
  const n = areas.length;
  if (n === 0) return [];

  if (variant === "split-vertical" && n >= 2) {
    const w = Math.floor((containerWidth - gap) / 2);
    const h = 320;
    return areas.map((a, i) => ({
      areaName: a.name,
      x: (i % 2) * (w + gap),
      y: Math.floor(i / 2) * (h + gap),
      width: w,
      height: h,
    }));
  }

  if (variant === "grid" && n >= 2) {
    const cols = Math.min(3, n);
    const w = Math.floor((containerWidth - gap * (cols - 1)) / cols);
    const h = 300;
    return areas.map((a, i) => ({
      areaName: a.name,
      x: (i % cols) * (w + gap),
      y: Math.floor(i / cols) * (h + gap),
      width: w,
      height: h,
    }));
  }

  // single-column / split-horizontal
  const h = 300;
  return areas.map((a, i) => ({
    areaName: a.name,
    x: 0,
    y: i * (h + gap),
    width: containerWidth,
    height: h,
  }));
}

/* ─── Container height helper ──────────────────────────────────────── */

export function computeContainerHeight(items: AreaLayoutItem[]): number {
  if (items.length === 0) return 200;
  return Math.max(...items.map((it) => it.y + it.height)) + 24;
}

/* ─── Resize direction types ───────────────────────────────────────── */

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", sw: "nesw-resize",
};

const MIN_W = 120;
const MIN_H = 80;

/* ─── EditableArea: free drag + 8-direction resize ─────────────────── */

interface EditableAreaProps {
  item: AreaLayoutItem;
  children: React.ReactNode;
  zIndex: number;
  onMove: (areaName: string, x: number, y: number) => void;
  onResize: (areaName: string, x: number, y: number, w: number, h: number) => void;
  onBringToFront: (areaName: string) => void;
}

export function EditableArea({
  item, children, zIndex,
  onMove, onResize, onBringToFront,
}: EditableAreaProps) {
  const [dragging, setDragging] = useState(false);
  const [resizeDir, setResizeDir] = useState<ResizeDir | null>(null);
  const startRef = useRef({ mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0 });

  const active = dragging || !!resizeDir;

  /* ── Free drag (mousedown on header bar) ── */
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-resize-handle]")) return;
    e.preventDefault();
    e.stopPropagation();
    onBringToFront(item.areaName);
    setDragging(true);
    startRef.current = { mx: e.clientX, my: e.clientY, x: item.x, y: item.y, w: item.width, h: item.height };

    const onMM = (ev: MouseEvent) => {
      const nx = Math.max(0, startRef.current.x + (ev.clientX - startRef.current.mx));
      const ny = Math.max(0, startRef.current.y + (ev.clientY - startRef.current.my));
      onMove(item.areaName, Math.round(nx), Math.round(ny));
    };
    const onMU = () => {
      setDragging(false);
      document.removeEventListener("mousemove", onMM);
      document.removeEventListener("mouseup", onMU);
    };
    document.addEventListener("mousemove", onMM);
    document.addEventListener("mouseup", onMU);
  }, [item, onMove, onBringToFront]);

  /* ── 8-direction resize ── */
  const handleResizeStart = useCallback((dir: ResizeDir) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onBringToFront(item.areaName);
    setResizeDir(dir);
    startRef.current = { mx: e.clientX, my: e.clientY, x: item.x, y: item.y, w: item.width, h: item.height };

    const onMM = (ev: MouseEvent) => {
      const dx = ev.clientX - startRef.current.mx;
      const dy = ev.clientY - startRef.current.my;
      let { x, y, w, h } = startRef.current;

      if (dir.includes("e")) w = Math.max(MIN_W, w + dx);
      if (dir.includes("w")) { const nw = Math.max(MIN_W, w - dx); x = x + (w - nw); w = nw; }
      if (dir.includes("s")) h = Math.max(MIN_H, h + dy);
      if (dir.includes("n")) { const nh = Math.max(MIN_H, h - dy); y = y + (h - nh); h = nh; }

      onResize(item.areaName, Math.round(Math.max(0, x)), Math.round(Math.max(0, y)), Math.round(w), Math.round(h));
    };
    const onMU = () => {
      setResizeDir(null);
      document.removeEventListener("mousemove", onMM);
      document.removeEventListener("mouseup", onMU);
    };
    document.addEventListener("mousemove", onMM);
    document.addEventListener("mouseup", onMU);
  }, [item, onResize, onBringToFront]);

  return (
    <div
      style={{
        position: "absolute",
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex,
        border: active ? "2px solid #6366f1" : "2px dashed #c7d2fe",
        borderRadius: 10,
        boxShadow: active
          ? "0 0 0 3px rgba(99,102,241,0.2), 0 8px 25px rgba(0,0,0,0.12)"
          : "0 2px 8px rgba(0,0,0,0.06)",
        transition: active ? "none" : "border-color .15s, box-shadow .15s",
        overflow: "hidden",
        background: "white",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Drag bar ── */}
      <div
        onMouseDown={handleDragStart}
        style={{
          height: 28,
          background: active
            ? "linear-gradient(135deg, #6366f1, #818cf8)"
            : "linear-gradient(135deg, #eef2ff, #f0f9ff)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          cursor: "move",
          userSelect: "none",
          borderBottom: "1px solid #e2e8f0",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, opacity: 0.6, letterSpacing: 2, color: active ? "#fff" : "#64748b" }}>⠿⠿</span>
        <span style={{
          fontSize: 11, fontWeight: 600, flex: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: active ? "#fff" : "#475569",
        }}>
          {item.areaName}
        </span>
        <span style={{
          fontSize: 9, color: active ? "rgba(255,255,255,.7)" : "#94a3b8",
          fontFamily: "monospace",
        }}>
          {Math.round(item.width)}×{Math.round(item.height)}
        </span>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {children}
      </div>

      {/* ── 8 resize handles ── */}
      {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDir[]).map((dir) => {
        const s: React.CSSProperties = { position: "absolute", zIndex: 100, cursor: RESIZE_CURSORS[dir] };
        const hs = 10;
        // Edge handles
        if (dir === "n") Object.assign(s, { top: -4, left: hs, right: hs, height: 8 });
        if (dir === "s") Object.assign(s, { bottom: -4, left: hs, right: hs, height: 8 });
        if (dir === "e") Object.assign(s, { right: -4, top: hs, bottom: hs, width: 8 });
        if (dir === "w") Object.assign(s, { left: -4, top: hs, bottom: hs, width: 8 });
        // Corner handles
        if (dir === "nw") Object.assign(s, { top: -4, left: -4, width: 14, height: 14 });
        if (dir === "ne") Object.assign(s, { top: -4, right: -4, width: 14, height: 14 });
        if (dir === "sw") Object.assign(s, { bottom: -4, left: -4, width: 14, height: 14 });
        if (dir === "se") Object.assign(s, { bottom: -4, right: -4, width: 14, height: 14 });

        const isCorner = dir.length === 2;
        return (
          <div key={dir} data-resize-handle="true" onMouseDown={handleResizeStart(dir)} style={s}>
            {isCorner && (
              <div style={{
                position: "absolute", inset: 2, width: 8, height: 8,
                borderRadius: 2,
                background: resizeDir === dir ? "#6366f1" : "#c7d2fe",
                border: "1px solid #6366f1",
                transition: "background .1s",
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── useLayoutEditor hook (free-form) ─────────────────────────────── */

export function useLayoutEditor(
  variant: string,
  areas: { name: string }[],
  containerRef: React.RefObject<HTMLDivElement | null>,
  options?: {
    initialItems?: AreaLayoutItem[];
    onLayoutChange?: (items: AreaLayoutItem[]) => void;
  },
) {
  const onLayoutChange = options?.onLayoutChange;
  const initialItems = options?.initialItems;
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<AreaLayoutItem[] | null>(
    initialItems && initialItems.length > 0 ? initialItems : null
  );
  const [zMap, setZMap] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!items) return;
    onLayoutChange?.(items);
  }, [items, onLayoutChange]);

  const enterEditing = useCallback(() => {
    if (!items && containerRef.current) {
      const w = containerRef.current.clientWidth || 800;
      setItems(computeInitialPositions(w, variant, areas));
    }
    setEditing(true);
  }, [items, variant, areas, containerRef]);

  const exitEditing = useCallback(() => {
    setEditing(false);
  }, []);

  const toggleEditing = useCallback(() => {
    if (editing) exitEditing();
    else enterEditing();
  }, [editing, enterEditing, exitEditing]);

  const resetLayout = useCallback(() => {
    setItems(null);
    setEditing(false);
    setZMap({});
  }, []);

  const handleMove = useCallback((areaName: string, x: number, y: number) => {
    setItems((prev) =>
      prev?.map((it) => it.areaName === areaName ? { ...it, x, y } : it) ?? null
    );
  }, []);

  const handleResize = useCallback((areaName: string, x: number, y: number, w: number, h: number) => {
    setItems((prev) =>
      prev?.map((it) => it.areaName === areaName ? { ...it, x, y, width: w, height: h } : it) ?? null
    );
  }, []);

  const bringToFront = useCallback((areaName: string) => {
    setZMap((prev) => {
      const maxZ = Math.max(0, ...Object.values(prev));
      return { ...prev, [areaName]: maxZ + 1 };
    });
  }, []);

  const containerHeight = useMemo(() => {
    if (!items) return undefined;
    return computeContainerHeight(items);
  }, [items]);

  return {
    editing,
    items,
    containerHeight,
    zMap,
    toggleEditing,
    resetLayout,
    handleMove,
    handleResize,
    bringToFront,
  };
}
