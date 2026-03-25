"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@/lib/i18n";
import styles from "./CommandPalette.module.css";

export type CommandItem = {
  id: string;
  label: string;
  group: string;
  href: string;
  keywords?: string[];
};

const STORAGE_KEY = "openslin_nav_visits";
const MAX_RECENT = 8;

function readVisits(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function recordVisit(href: string) {
  if (typeof window === "undefined") return;
  try {
    const visits = readVisits();
    visits[href] = (visits[href] ?? 0) + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
  } catch { /* quota exceeded etc. */ }
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M12.5 12.5 17 17" />
    </svg>
  );
}

export function CommandPalette(props: {
  items: CommandItem[];
  locale: string;
  open: boolean;
  onClose: () => void;
}) {
  const { items, open, onClose } = props;
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      // Show recent/frequent items when no query
      const visits = readVisits();
      const sorted = [...items].sort((a, b) => (visits[b.href] ?? 0) - (visits[a.href] ?? 0));
      return sorted.slice(0, MAX_RECENT);
    }
    return items.filter((item) => {
      const hay = `${item.label} ${item.group} ${(item.keywords ?? []).join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [items, query]);

  const navigate = useCallback(
    (item: CommandItem) => {
      recordVisit(item.href);
      onClose();
      router.push(item.href);
    },
    [onClose, router],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && filtered[activeIdx]) {
        e.preventDefault();
        navigate(filtered[activeIdx]);
        return;
      }
    },
    [onClose, filtered, activeIdx, navigate],
  );

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  if (!open) return null;

  // Group filtered results
  const groups = new Map<string, CommandItem[]>();
  for (const item of filtered) {
    const g = groups.get(item.group) ?? [];
    g.push(item);
    groups.set(item.group, g);
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.inputRow}>
          <SearchIcon />
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder={t(props.locale, "cmdPalette.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={styles.results}>
          {filtered.length === 0 && (
            <div className={styles.empty}>
              {t(props.locale, "cmdPalette.noResults")}
            </div>
          )}
          {(() => {
            let globalIdx = 0;
            return Array.from(groups.entries()).map(([groupLabel, groupItems]) => (
              <div key={groupLabel}>
                <div className={styles.groupLabel}>{groupLabel}</div>
                {groupItems.map((item) => {
                  const idx = globalIdx++;
                  return (
                    <div
                      key={item.id}
                      className={styles.item}
                      data-active={idx === activeIdx ? "true" : undefined}
                      onClick={() => navigate(item)}
                      onMouseEnter={() => setActiveIdx(idx)}
                    >
                      <span>{item.label}</span>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>

        <div className={styles.footer}>
          <span className={styles.kbd}>↑↓</span> {t(props.locale, "cmdPalette.footer.navigate")}
          <span className={styles.kbd}>↵</span> {t(props.locale, "cmdPalette.footer.open")}
          <span className={styles.kbd}>Esc</span> {t(props.locale, "cmdPalette.footer.close")}
        </div>
      </div>
    </div>
  );
}

/** Global keyboard hook: call from layout or shell to enable Ctrl+K */
export function useCommandPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onOpen]);
}
