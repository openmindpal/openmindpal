"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";

export type UndoToastItem = {
  id: string;
  message: string;
  delaySec: number;
  onExecute: () => void;
  onCancel?: () => void;
};

export function useUndoQueue() {
  const [items, setItems] = useState<(UndoToastItem & { remaining: number; cancelled: boolean; executed: boolean })[]>([]);
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const enqueue = useCallback((item: UndoToastItem) => {
    setItems((prev) => [...prev, { ...item, remaining: item.delaySec, cancelled: false, executed: false }]);
    /* countdown */
    const interval = setInterval(() => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== item.id || it.cancelled || it.executed) return it;
          const next = it.remaining - 1;
          if (next <= 0) {
            clearInterval(interval);
            timersRef.current.delete(item.id);
            item.onExecute();
            return { ...it, remaining: 0, executed: true };
          }
          return { ...it, remaining: next };
        }),
      );
    }, 1000);
    timersRef.current.set(item.id, interval);
  }, []);

  const cancel = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) { clearInterval(timer); timersRef.current.delete(id); }
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id || it.executed) return it;
        it.onCancel?.();
        return { ...it, cancelled: true };
      }),
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  /* auto dismiss after 3s */
  useEffect(() => {
    const done = items.filter((it) => it.cancelled || it.executed);
    if (!done.length) return;
    const timeouts = done.map((it) =>
      setTimeout(() => dismiss(it.id), 3000),
    );
    return () => timeouts.forEach(clearTimeout);
  }, [items, dismiss]);

  return { items, enqueue, cancel, dismiss };
}

export function UndoToastContainer(props: {
  items: ReturnType<typeof useUndoQueue>["items"];
  onCancel: (id: string) => void;
  locale: string;
}) {
  if (!props.items.length) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      zIndex: 10000, display: "flex", flexDirection: "column", gap: 8,
    }}>
      {props.items.map((item) => (
        <div key={item.id} style={{
          background: item.cancelled ? "#f44336" : item.executed ? "#4caf50" : "#333",
          color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 14,
          display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 16px rgba(0,0,0,.25)",
          minWidth: 280, transition: "opacity .3s",
        }}>
          <span style={{ flex: 1 }}>
            {item.cancelled
              ? t(props.locale, "undo.cancelled")
              : item.executed
                ? t(props.locale, "undo.executed")
                : t(props.locale, "undo.pending").replace("{seconds}", String(item.remaining))}
          </span>
          {!item.cancelled && !item.executed && (
            <button
              onClick={() => props.onCancel(item.id)}
              style={{
                background: "rgba(255,255,255,.2)", border: "1px solid rgba(255,255,255,.4)",
                color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 13,
              }}
            >
              {t(props.locale, "undo.cancel")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
