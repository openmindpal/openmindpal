"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { type RecentEntry } from "./homeHelpers";
import { IconClock, IconPage, IconConsole, IconGov } from "./HomeIcons";
import styles from "./page.module.css";

/* ─── Types ──────────────────────────────────────────────────────────── */

type CmdItem = { id: string; label: string; section: string; href: string; icon: "page" | "console" | "gov" | "recent" };

function buildStaticCmdItems(locale: string): CmdItem[] {
  return [
    { id: "c_runs", label: t(locale, "shell.nav.runs"), section: "console", href: "/runs", icon: "console" },
    { id: "c_tasks", label: t(locale, "shell.nav.tasks"), section: "console", href: "/tasks", icon: "console" },
    { id: "c_orch", label: t(locale, "shell.nav.orchestrator"), section: "console", href: "/orchestrator", icon: "console" },
    { id: "c_settings", label: t(locale, "home.settings"), section: "console", href: "/settings", icon: "console" },
    { id: "g_cs", label: t(locale, "gov.nav.changesets"), section: "governance", href: "/gov/changesets", icon: "gov" },
    { id: "g_schemas", label: t(locale, "gov.nav.schemas"), section: "governance", href: "/gov/schemas", icon: "gov" },
    { id: "g_tools", label: t(locale, "gov.nav.tools"), section: "governance", href: "/gov/tools", icon: "gov" },
    { id: "g_safety", label: t(locale, "gov.nav.safetyPolicies"), section: "governance", href: "/gov/safety-policies", icon: "gov" },
    { id: "g_skill", label: t(locale, "gov.nav.skillPackages"), section: "governance", href: "/gov/skill-packages", icon: "gov" },
    { id: "g_approvals", label: t(locale, "gov.nav.approvals"), section: "governance", href: "/gov/approvals", icon: "gov" },
    { id: "g_audit", label: t(locale, "gov.nav.audit"), section: "governance", href: "/gov/audit", icon: "gov" },
    { id: "g_obs", label: t(locale, "gov.nav.observability"), section: "governance", href: "/gov/observability", icon: "gov" },
    { id: "g_models", label: t(locale, "gov.nav.models"), section: "governance", href: "/gov/models", icon: "gov" },
    { id: "g_channels", label: t(locale, "gov.nav.channels"), section: "governance", href: "/gov/channels", icon: "gov" },
    { id: "g_triggers", label: t(locale, "gov.nav.triggers"), section: "governance", href: "/gov/triggers", icon: "gov" },
    { id: "g_devices", label: t(locale, "gov.nav.devices"), section: "governance", href: "/gov/devices", icon: "gov" },
    { id: "g_sync", label: t(locale, "gov.nav.sync"), section: "governance", href: "/gov/sync", icon: "gov" },
  ];
}

/* ─── Component ──────────────────────────────────────────────────────── */

export default function CommandPalette(props: {
  locale: string;
  open: boolean;
  onClose: () => void;
  onSelect: (href: string) => void;
  recent: RecentEntry[];
}) {
  const { locale, open, onClose, onSelect, recent } = props;
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const staticItems = useMemo(() => buildStaticCmdItems(locale), [locale]);

  const recentItems: CmdItem[] = useMemo(() =>
    recent.slice(0, 6).map((r, i) => ({
      id: `r_${i}`,
      label: r.name,
      section: "recent",
      href: r.kind === "page" ? `/p/${encodeURIComponent(r.name)}` : `/w/${encodeURIComponent(r.name)}`,
      icon: "recent" as const,
    })),
  [recent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...recentItems, ...staticItems];
    if (!q) return all;
    return all.filter((item) => item.label.toLowerCase().includes(q) || item.href.toLowerCase().includes(q));
  }, [query, recentItems, staticItems]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setQuery("");
      setActiveIdx(0);
      inputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open]);

  const sectionLabel = useCallback((s: string) => {
    const map: Record<string, string> = { recent: "cmdPalette.section.recent", console: "cmdPalette.section.console", governance: "cmdPalette.section.governance", pages: "cmdPalette.section.pages" };
    return t(locale, map[s] ?? s);
  }, [locale]);

  const iconFor = useCallback((icon: CmdItem["icon"]) => {
    if (icon === "recent") return <IconClock />;
    if (icon === "page") return <IconPage />;
    if (icon === "console") return <IconConsole />;
    return <IconGov />;
  }, []);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((p) => Math.min(p + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((p) => Math.max(p - 1, 0)); return; }
    if (e.key === "Enter" && filtered[activeIdx]) { e.preventDefault(); onSelect(filtered[activeIdx].href); return; }
  }, [activeIdx, filtered, onClose, onSelect]);

  if (!open) return null;

  let lastSection = "";
  return (
    <div className={styles.cmdOverlay} onClick={onClose}>
      <div className={styles.cmdDialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKey}>
        <input
          ref={inputRef}
          className={styles.cmdInput}
          placeholder={t(locale, "cmdPalette.placeholder")}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
        />
        <div className={styles.cmdResults}>
          {filtered.length === 0 && <div className={styles.cmdEmpty}>{t(locale, "cmdPalette.noResults")}</div>}
          {filtered.map((item, idx) => {
            const showSection = item.section !== lastSection;
            lastSection = item.section;
            return (
              <div key={item.id}>
                {showSection && <div className={styles.cmdSection}>{sectionLabel(item.section)}</div>}
                <div
                  className={`${styles.cmdItem} ${idx === activeIdx ? styles.cmdItemActive : ""}`}
                  onClick={() => onSelect(item.href)}
                  onMouseEnter={() => setActiveIdx(idx)}
                >
                  <span className={styles.cmdItemIcon}>{iconFor(item.icon)}</span>
                  <span className={styles.cmdItemLabel}>{item.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
