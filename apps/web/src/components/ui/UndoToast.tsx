"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type UndoAction = {
  id: string;
  label: string;
  durationMs?: number;
  onConfirm: () => void | Promise<void>;
  onUndo?: () => void;
};

type ToastEntry = UndoAction & { startedAt: number; remaining: number };

/**
 * useUndoToast — architecture section 15.5 delay-confirm / Undo
 *
 * Shows a toast with countdown; user can click "Undo" to cancel.
 * If the timer expires, the action is confirmed automatically.
 */
export function useUndoToast() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const enqueue = useCallback((action: UndoAction) => {
    const duration = action.durationMs ?? 5000;
    const entry: ToastEntry = { ...action, startedAt: Date.now(), remaining: duration };
    setToasts((prev) => [...prev, entry]);

    const interval = setInterval(() => {
      const elapsed = Date.now() - entry.startedAt;
      const remaining = Math.max(0, duration - elapsed);

      if (remaining <= 0) {
        clearInterval(interval);
        timers.current.delete(action.id);
        setToasts((prev) => prev.filter((t) => t.id !== action.id));
        /* Fire onConfirm OUTSIDE the state-updater to avoid side-effects in pure functions */
        void Promise.resolve(action.onConfirm()).catch(() => {});
        return;
      }

      setToasts((prev) =>
        prev.map((t) => (t.id === action.id ? { ...t, remaining } : t)),
      );
    }, 200);

    timers.current.set(action.id, interval);
  }, []);

  const undo = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearInterval(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => {
      const entry = prev.find((t) => t.id === id);
      if (entry?.onUndo) entry.onUndo();
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  useEffect(() => {
    const timersMap = timers.current;
    return () => {
      for (const timer of timersMap.values()) clearInterval(timer);
    };
  }, []);

  return { toasts, enqueue, undo };
}

/* --- UndoToast UI Component --- */

export function UndoToastContainer(props: {
  toasts: ToastEntry[];
  onUndo: (id: string) => void;
  undoLabel?: string;
}) {
  if (!props.toasts.length) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 10000,
      display: "flex", flexDirection: "column", gap: 8, maxWidth: 360,
    }}>
      {props.toasts.map((t) => {
        const pct = t.durationMs ? Math.max(0, t.remaining / t.durationMs) * 100 : 50;
        return (
          <div key={t.id} style={{
            background: "#1a1a2e", color: "#eee", borderRadius: 8, padding: "12px 16px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)", display: "flex", alignItems: "center", gap: 12,
            position: "relative", overflow: "hidden",
          }}>
            <div style={{
              position: "absolute", bottom: 0, left: 0, height: 3,
              width: `${pct}%`, background: "#6c63ff", transition: "width 0.2s linear",
            }} />
            <span style={{ flex: 1, fontSize: 14 }}>{t.label}</span>
            <button
              onClick={() => props.onUndo(t.id)}
              style={{
                background: "transparent", border: "1px solid #6c63ff", color: "#6c63ff",
                borderRadius: 4, padding: "4px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600,
              }}
            >
              {props.undoLabel ?? "Undo"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
