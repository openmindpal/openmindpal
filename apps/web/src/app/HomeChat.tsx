"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { apiFetch, setLocale } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errorMessageText, isPlainObject, nextId, safeJsonString } from "@/lib/apiError";
import { type ToolSuggestion, type ExecuteResponse } from "@/lib/types";
import DynamicBlockRenderer, { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";
import {
  type FlowDirective, type FlowNl2UiResult,
  type WorkspaceTab, type ToolExecState, type ChatFlowItem, type RecentEntry,
  TERMINAL_RUN_STATUSES, NAV_ITEMS,
  loadRecent, addRecent, clearRecent,
  friendlyToolName, riskBadgeKey, riskBadgeClass, friendlyOutputSummary,
  friendlyErrorMessage, targetFromUiDirective,
} from "./homeHelpers";
import { IconClose, IconExternal, IconPanel, IconMaximize, IconMinimize, IconChevronLeft, IconChevronRight, IconSearch, IconPage } from "./HomeIcons";
import CommandPalette from "./CommandPalette";
import styles from "./page.module.css";

/* ─── Component ────────────────────────────────────────────────────────── */

export default function HomeChat(props: { locale: string }) {
  const locale = props.locale;
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialScrollDoneRef = useRef(false); // Track if initial scroll is done

  const [draft, setDraft] = useState("");
  const [flow, setFlow] = useState<ChatFlowItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [nl2uiLoading, setNl2uiLoading] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const lastRetryMsgRef = useRef<string | null>(null);

  /* ─── Inline tool execution state (declared early for session persistence) ─── */
  const [toolExecStates, setToolExecStates] = useState<Record<string, ToolExecState>>({});
  const pendingTsIdsRef = useRef<string[]>([]);

  /* ─── Session persistence (survives page refresh) ─── */
  const SESSION_KEY = "openslin_chat_session";
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { conversationId?: string; flow?: ChatFlowItem[]; toolExecStates?: Record<string, ToolExecState> };
        if (saved.conversationId) setConversationId(saved.conversationId);
        if (Array.isArray(saved.flow) && saved.flow.length) setFlow(saved.flow);
        if (saved.toolExecStates && typeof saved.toolExecStates === "object") {
          // Only restore terminal states (done/error); discard transient states (executing/polling)
          const restored: Record<string, ToolExecState> = {};
          for (const [k, v] of Object.entries(saved.toolExecStates)) {
            if (v && (v.status === "done" || v.status === "error")) restored[k] = v;
          }
          if (Object.keys(restored).length) setToolExecStates(restored);
        }
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      if (flow.length || conversationId) {
        // Only persist terminal exec states to avoid stale transient states
        const persistable: Record<string, ToolExecState> = {};
        for (const [k, v] of Object.entries(toolExecStates)) {
          if (v.status === "done" || v.status === "error") persistable[k] = v;
        }
        localStorage.setItem(SESSION_KEY, JSON.stringify({ conversationId, flow, toolExecStates: persistable }));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch { /* ignore */ }
  }, [flow, conversationId, toolExecStates]);

  /* ─── Sync html lang attribute on mount ─── */
  useEffect(() => { setLocale(locale); }, [locale]);

  const [directiveNav, setDirectiveNav] = useState<Record<string, { status: "checking" } | { status: "allowed" } | { status: "blocked"; hint: string }>>({});
  const directiveValidationStartedRef = useRef<Set<string>>(new Set());

  /* ─── Split layout state (left panel width, collapsed states) ─── */
  const SPLIT_KEY = "openslin_split_layout";
  
  // Track if layout is mounted on client to prevent SSR hydration flash
  const [layoutMounted, setLayoutMounted] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(50);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  // Restore layout from localStorage on client mount (runs once)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SPLIT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { leftWidth?: number; leftCollapsed?: boolean; rightCollapsed?: boolean };
        if (typeof saved.leftWidth === "number") setLeftWidth(saved.leftWidth);
        if (typeof saved.leftCollapsed === "boolean") setLeftCollapsed(saved.leftCollapsed);
        if (typeof saved.rightCollapsed === "boolean") setRightCollapsed(saved.rightCollapsed);
      }
    } catch { /* ignore */ }
    // Mark layout as mounted after restoring state
    setLayoutMounted(true);
  }, []);

  // Persist split layout changes
  useEffect(() => {
    if (!layoutMounted) return; // Don't persist during initial mount
    try { localStorage.setItem(SPLIT_KEY, JSON.stringify({ leftWidth, leftCollapsed, rightCollapsed })); } catch { /* ignore */ }
  }, [leftWidth, leftCollapsed, rightCollapsed, layoutMounted]);

  // Drag resize handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      if (!splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(15, Math.min(85, pct)));
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((p) => {
      if (!p && rightCollapsed) setRightCollapsed(false);
      return !p;
    });
  }, [rightCollapsed]);
  const toggleRight = useCallback(() => {
    setRightCollapsed((p) => {
      if (!p && leftCollapsed) setLeftCollapsed(false);
      return !p;
    });
  }, [leftCollapsed]);

  /* ─── Workspace tabs state ─── */
  const WORKSPACE_KEY = "openslin_workspace_tabs";
  const [pinnedTabs, setPinnedTabs] = useState<WorkspaceTab[]>([]);
  const [previewTab, setPreviewTab] = useState<WorkspaceTab | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Persist / restore pinned workspace tabs
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { pinned?: WorkspaceTab[]; activeTabId?: string | null };
        if (Array.isArray(saved.pinned) && saved.pinned.length) {
          setPinnedTabs(saved.pinned);
          setActiveTabId(saved.activeTabId ?? saved.pinned[0]?.id ?? null);
        }
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ pinned: pinnedTabs, activeTabId }));
    } catch { /* ignore */ }
  }, [pinnedTabs, activeTabId]);

  // Derived: the currently visible tab (active pinned tab, or preview)
  const visibleTab: WorkspaceTab | null = useMemo(() => {
    if (activeTabId === "__preview__" && previewTab) return previewTab;
    const found = pinnedTabs.find((t) => t.id === activeTabId);
    if (found) return found;
    if (previewTab) return previewTab;
    return pinnedTabs[0] ?? null;
  }, [pinnedTabs, previewTab, activeTabId]);

  // Workspace actions
  const openInWorkspace = useCallback((entry: { kind: "page" | "workbench"; name: string; url: string }) => {
    // Check if already pinned — if so, just switch to it
    const existing = pinnedTabs.find((t) => t.kind === entry.kind && t.name === entry.name);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      // Open as preview (temporary)
      const tab: WorkspaceTab = { id: "__preview__", kind: entry.kind, name: entry.name, url: entry.url };
      setPreviewTab(tab);
      setActiveTabId("__preview__");
    }
    if (leftCollapsed) setLeftCollapsed(false);
  }, [pinnedTabs, leftCollapsed]);

  const pinCurrentPreview = useCallback(() => {
    if (!previewTab) return;
    const newTab: WorkspaceTab = { ...previewTab, id: `ws_${Date.now()}` };
    setPinnedTabs((prev) => {
      // Avoid duplicates
      if (prev.some((t) => t.kind === newTab.kind && t.name === newTab.name)) return prev;
      return [...prev, newTab];
    });
    setActiveTabId(newTab.id);
    setPreviewTab(null);
  }, [previewTab]);

  const unpinTab = useCallback((tabId: string) => {
    setPinnedTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      // If active tab was removed, switch to another
      if (activeTabId === tabId) {
        const idx = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.min(idx, next.length - 1)];
        setActiveTabId(fallback?.id ?? (previewTab ? "__preview__" : null));
      }
      return next;
    });
  }, [activeTabId, previewTab]);

  const closePreview = useCallback(() => {
    setPreviewTab(null);
    if (activeTabId === "__preview__") {
      setActiveTabId(pinnedTabs[pinnedTabs.length - 1]?.id ?? null);
    }
  }, [activeTabId, pinnedTabs]);

  /* ─── NL2UI save-as-page state ─── */
  const [savingPageId, setSavingPageId] = useState<string | null>(null);
  const [savedPages, setSavedPages] = useState<Record<string, { pageName: string; pageUrl: string }>>({}); 

  /* ─── NL2UI maximize state ─── */
  const [maximizedNl2ui, setMaximizedNl2ui] = useState<FlowNl2UiResult | null>(null);

  /* ─── Recent pages state ─── */
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  useEffect(() => { setRecent(loadRecent()); }, []);

  /* ─── CommandPalette state ─── */
  const [cmdOpen, setCmdOpen] = useState(false);

  const hasMessages = flow.length > 0;
  const canSend = useMemo(() => Boolean(draft.trim()) && !busy, [busy, draft]);
  const q = useCallback((p: string) => `${p}?lang=${encodeURIComponent(locale)}`, [locale]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setCmdOpen((p) => !p); }
      if (e.key === "Escape") {
        if (maximizedNl2ui) { setMaximizedNl2ui(null); return; }
        if (cmdOpen) setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cmdOpen, maximizedNl2ui]);

  /* auto-scroll on new messages */
  useEffect(() => {
    if (!scrollRef.current) return;
    // Use instant scroll for initial load, smooth scroll for new messages
    const behavior = initialScrollDoneRef.current ? "smooth" : "instant";
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
    initialScrollDoneRef.current = true;
  }, [flow]);

  useEffect(() => {
    function onOnline() {
      const msg = lastRetryMsgRef.current;
      if (!msg) return;
      setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "NETWORK_RESTORED", message: t(locale, "chat.network.restored"), traceId: "", retryMessage: msg }]);
    }
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [locale]);

  const startNew = useCallback(() => {
    if (busy) return;
    /* Abort any in-flight SSE stream */
    abortRef.current?.abort();
    abortRef.current = null;
    setConversationId(""); setFlow([]); setToolExecStates({}); try { localStorage.removeItem(SESSION_KEY); } catch {}
  }, [busy]);

  /* ─── send message (SSE streaming) ─── */
  const send = useCallback(async (overrideMsg?: string, opts?: { appendUser?: boolean }) => {
    const message = (overrideMsg ?? draft).trim();
    if (!message || busy) return;
    const appendUser = opts?.appendUser !== false;
    if (appendUser) setDraft("");
    setBusy(true);
    if (appendUser) setFlow((prev) => [...prev, { kind: "message", id: nextId("m"), role: "user", text: message }]);

    setNl2uiLoading(false);

    /* Streaming reply placeholder */
    const replyId = nextId("m");
    setFlow((prev) => [...prev, { kind: "message", id: replyId, role: "assistant", text: "" }]);

    /* Create AbortController for cancellable SSE stream */
    const controller = new AbortController();
    abortRef.current = controller;

    let abortedByTimeout = false;
    try {
      const res = await apiFetch(`/orchestrator/turn/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({
          message,
          locale,
          ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errJson: unknown = await res.json().catch(() => null);
        const e = isPlainObject(errJson) ? (errJson as ApiError) : {};
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfterSec = Number((e as any).retryAfterSec ?? retryAfterHeader);
        const retryHint =
          res.status === 429 && Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? ` (${t(locale, "error.retryIn")} ${Math.ceil(retryAfterSec)}s)`
            : "";
        const traceId = String((e as any).traceId ?? "");
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
          errorCode: String(e.errorCode ?? res.status), message: `${errorMessageText(locale, e.message ?? res.statusText)}${retryHint}`, traceId,
        }]);
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accText = "";
      const STALE_TIMEOUT_DEFAULT = 30_000;
      const STALE_TIMEOUT_NL2UI = 120_000;
      let staleTimeoutMs = STALE_TIMEOUT_DEFAULT;
      let lastChunkAt = Date.now();

      while (true) {
        const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const elapsedMs = Date.now() - lastChunkAt;
          const waitMs = Math.max(0, staleTimeoutMs - elapsedMs);
          const tid = window.setTimeout(() => {
            abortedByTimeout = true;
            try { controller.abort(); } catch {}
            const e: any = new Error("STREAM_STALE_TIMEOUT");
            e.code = "STREAM_STALE_TIMEOUT";
            reject(e);
          }, waitMs);
          reader.read().then((r) => {
            window.clearTimeout(tid);
            resolve(r);
          }).catch((e) => {
            window.clearTimeout(tid);
            reject(e);
          });
        });
        if (done) break;
        lastChunkAt = Date.now();
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          if (!part.trim()) continue;
          let event = "";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!event || !data) continue;
          try {
            const d = JSON.parse(data);
            switch (event) {
              case "delta":
                accText += d.text ?? "";
                setFlow((prev) => prev.map((it) => (it.id === replyId ? { ...it, text: accText } : it)));
                break;
              case "toolSuggestions": {
                const suggestions = d && Array.isArray(d.suggestions) ? (d.suggestions as ToolSuggestion[]) : [];
                if (suggestions.length) {
                  const tsId = nextId("ts");
                  pendingTsIdsRef.current.push(tsId);
                  setFlow((prev) => [...prev, { kind: "toolSuggestions", id: tsId, role: "assistant", suggestions }]);
                }
                break;
              }
              case "nl2uiStatus":
                if (d && d.phase === "started") {
                  setNl2uiLoading(true);
                  staleTimeoutMs = STALE_TIMEOUT_NL2UI;
                  lastChunkAt = Date.now();
                }
                if (d && d.phase === "done") {
                  setNl2uiLoading(false);
                  staleTimeoutMs = STALE_TIMEOUT_DEFAULT;
                }
                break;
              case "keepalive":
                break;
              case "nl2uiResult":
                setNl2uiLoading(false);
                if (d && d.config) {
                  const cfg = d.config as Nl2UiConfig;
                  setFlow((prev) => [...prev, {
                    kind: "nl2uiResult" as const,
                    id: nextId("ui"),
                    role: "assistant" as const,
                    config: cfg,
                    userInput: message,
                    suggestions: Array.isArray((cfg as any).suggestions) ? ((cfg as any).suggestions as string[]) : [],
                  }]);
                }
                break;
              case "nl2uiError":
                setNl2uiLoading(false);
                setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
                  errorCode: String(d?.errorCode ?? "NL2UI_ERROR"), message: errorMessageText(locale, d?.message ?? ""), traceId: String(d?.traceId ?? ""),
                  retryMessage: message,
                }]);
                break;
              case "uiDirective":
                setFlow((prev) => [...prev, {
                  kind: "uiDirective", id: nextId("d"), role: "assistant",
                  directive: d.directive, target: targetFromUiDirective(d.directive),
                }]);
                break;
              case "done": {
                if (d.conversationId) setConversationId(String(d.conversationId));
                const doneTurnId = String(d.turnId ?? "");
                if (doneTurnId && pendingTsIdsRef.current.length) {
                  const ids = [...pendingTsIdsRef.current];
                  pendingTsIdsRef.current = [];
                  setFlow((prev) => prev.map((it) => ids.includes(it.id) && it.kind === "toolSuggestions" ? { ...it, turnId: doneTurnId } : it));
                }
                break;
              }
              case "error":
                const retryAfterSec = Number((d as any)?.retryAfterSec);
                const retryHint =
                  Number.isFinite(retryAfterSec) && retryAfterSec > 0
                    ? ` (${t(locale, "error.retryIn")} ${Math.ceil(retryAfterSec)}s)`
                    : "";
                setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
                  errorCode: String(d.errorCode ?? "STREAM_ERROR"),
                  message: `${errorMessageText(locale, d.message)}${retryHint}`, traceId: String((d as any)?.traceId ?? ""),
                  retryMessage: message,
                }]);
                break;
            }
          } catch (parseErr) {
            /* Log SSE parse errors as visible error items instead of silently ignoring */
            const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode: "STREAM_PARSE_ERROR", message: parseMsg, traceId: "" }]);
          }
        }
      }

      /* If streaming left an empty reply, remove the placeholder */
      if (!accText) {
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
      }
      lastRetryMsgRef.current = null;
    } catch (err) {
      /* Ignore AbortError when user intentionally cancels */
      if (err instanceof DOMException && err.name === "AbortError" && !String((err as any)?.code ?? "").includes("STREAM_STALE_TIMEOUT")) {
        /* Remove the empty streaming placeholder */
        setFlow((prev) => prev.filter((it) => it.id !== replyId));
      } else {
        const code = String((err as any)?.code ?? (err as any)?.errorCode ?? "");
        const stale = code === "STREAM_STALE_TIMEOUT" || String((err as any)?.message ?? "") === "STREAM_STALE_TIMEOUT";
        const msg = stale ? t(locale, "chat.stream.stale") : err instanceof Error ? err.message : String(err);
        const errorCode = stale ? "STREAM_STALE_TIMEOUT" : abortedByTimeout ? "STREAM_STALE_TIMEOUT" : "NETWORK_ERROR";
        lastRetryMsgRef.current = message;
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant", errorCode, message: msg, traceId: "", retryMessage: message }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [busy, conversationId, draft, locale]);

  /* ─── validate UI directives ─── */
  const validateDirective = useCallback(async (it: FlowDirective) => {
    const target = it.target;
    if (!target) return;
    try {
      if (target.kind === "page") {
        const res = await apiFetch(`/ui/pages/${encodeURIComponent(target.name)}`, { method: "GET", locale, cache: "no-store" });
        if (res.status === 401 || res.status === 403) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.forbidden") } })); return; }
        const json: unknown = await res.json().catch(() => null);
        if (res.ok && isPlainObject(json) && (json as Record<string, unknown>).released != null) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "allowed" } })); return; }
        setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.pageNotReleased") } })); return;
      }
      if (target.kind === "workbench") {
        const res = await apiFetch(`/workbenches/${encodeURIComponent(target.key)}/effective`, { method: "GET", locale, cache: "no-store" });
        if (res.status === 401 || res.status === 403) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.forbidden") } })); return; }
        if (res.status === 200) { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "allowed" } })); return; }
        setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.workbenchUnavailable") } })); return;
      }
    } catch { setDirectiveNav((p) => ({ ...p, [it.id]: { status: "blocked", hint: t(locale, "chat.uiDirective.validationFailed") } })); }
  }, [locale]);

  useEffect(() => {
    for (const it of flow) {
      if (it.kind !== "uiDirective" || !it.target) continue;
      if (directiveValidationStartedRef.current.has(it.id)) continue;
      directiveValidationStartedRef.current.add(it.id);
      setDirectiveNav((p) => ({ ...p, [it.id]: { status: "checking" } }));
      void validateDirective(it);
    }
  }, [flow, validateDirective]);

  const openDirective = useCallback((it: FlowDirective, mode: "panel" | "navigate" = "panel") => {
    const target = it.target;
    if (!target || directiveNav[it.id]?.status !== "allowed") return;
    const pagePath = target.kind === "page"
      ? `/p/${encodeURIComponent(target.name)}?lang=${encodeURIComponent(locale)}`
      : `/w/${encodeURIComponent(target.key)}?lang=${encodeURIComponent(locale)}`;

    /* Track recent */
    const entry = target.kind === "page" ? { kind: "page" as const, name: target.name } : { kind: "workbench" as const, name: target.key };
    setRecent(addRecent(entry));

    if (mode === "panel") {
      openInWorkspace({ kind: target.kind, name: target.kind === "page" ? target.name : target.key, url: pagePath });
    } else {
      router.push(pagePath);
    }
  }, [directiveNav, locale, router, openInWorkspace]);

  /* ─── close panel (close current visible tab) ─── */
  const closePanel = useCallback(() => {
    if (activeTabId === "__preview__") {
      closePreview();
    } else if (activeTabId) {
      unpinTab(activeTabId);
    }
  }, [activeTabId, closePreview, unpinTab]);

  /* ─── T5: save NL2UI result as page ─── */
  const saveAsPage = useCallback(async (flowItemId: string, config: Nl2UiConfig, userInput: string) => {
    setSavingPageId(flowItemId);
    try {
      const res = await apiFetch(`/nl2ui/save-page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({
          config,
          title: userInput.slice(0, 80),
          autoPublish: true,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { success: boolean; pageName: string; pageUrl: string };
        if (data.success) {
          setSavedPages((prev) => ({ ...prev, [flowItemId]: { pageName: data.pageName, pageUrl: data.pageUrl } }));
          // Add to recent
          setRecent(addRecent({ kind: "page", name: data.pageName }));
        }
      }
    } catch { /* ignore */ }
    setSavingPageId(null);
  }, [locale]);

  /* ─── open recent item in workspace ─── */
  const openRecentInPanel = useCallback((entry: RecentEntry) => {
    const url = entry.kind === "page"
      ? `/p/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`
      : `/w/${encodeURIComponent(entry.name)}?lang=${encodeURIComponent(locale)}`;
    openInWorkspace({ kind: entry.kind, name: entry.name, url });
    setRecent(addRecent({ kind: entry.kind, name: entry.name }));
  }, [locale, openInWorkspace]);

  /* ─── CommandPalette select handler ─── */
  const handleCmdSelect = useCallback((href: string) => {
    setCmdOpen(false);
    router.push(q(href));
  }, [router, q]);

  /* ─── clear recent ─── */
  const handleClearRecent = useCallback(() => { clearRecent(); setRecent([]); }, []);

  /* ─── Poll helper: repeatedly GET /runs/:runId until terminal ─── */
  const pollRunResult = useCallback(async (execKey: string, runId: string, result: ExecuteResponse) => {
    const POLL_INTERVAL = 1500;
    const MAX_POLL_TIME = 60_000;
    const startedAt = Date.now();

    setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "polling", runId } }));

    const poll = async (): Promise<void> => {
      if (Date.now() - startedAt > MAX_POLL_TIME) {
        // Timeout – fall back to showing the queued result
        setToolExecStates((prev) => ({
          ...prev,
          [execKey]: { status: "error", message: t(locale, "chat.toolSuggestion.pollTimeout") },
        }));
        return;
      }

      try {
        const res = await apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET", locale });
        if (!res.ok) {
          // API error – stop polling, show queued result with link
          setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "queued" } }));
          return;
        }
        const data = (await res.json()) as { run?: { status?: string }; steps?: Array<{ status?: string; outputDigest?: unknown; errorCategory?: string; lastError?: string }> };
        const runStatus = String(data.run?.status ?? "queued");

        if (TERMINAL_RUN_STATUSES.has(runStatus)) {
          // Extract first step output for display
          const step0 = Array.isArray(data.steps) ? data.steps[0] : undefined;
          const stepOutput = step0?.outputDigest ?? null;
          const stepError = step0?.lastError ?? step0?.errorCategory ?? undefined;
          setToolExecStates((prev) => ({
            ...prev,
            [execKey]: { status: "done", result, runStatus, stepOutput, stepError },
          }));
          return;
        }

        // Still running – update status and schedule next poll
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "polling", runId, runStatus } }));
      } catch {
        // Network error during poll – show queued result with link
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "queued" } }));
        return;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      return poll();
    };

    await poll();
  }, [locale]);

  /* ─── Inline tool execute handler ─── */
  const executeToolInline = useCallback(async (flowItemId: string, suggestionIdx: number, s: ToolSuggestion) => {
    const execKey = `${flowItemId}_${suggestionIdx}`;
    setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "executing" } }));
    try {
      const toolRef = String(s.toolRef ?? "").trim();
      if (!toolRef) throw new Error(t(locale, "error.missingToolRef"));
      const body: Record<string, unknown> = { toolRef, input: s.inputDraft ?? {} };
      if (s.idempotencyKey) body.idempotencyKey = s.idempotencyKey;
      const res = await apiFetch(`/orchestrator/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = isPlainObject(json) ? (json as ApiError) : {};
        throw new Error(errorMessageText(locale, e.message ?? String(e.errorCode ?? res.statusText)));
      }
      const result = (json as ExecuteResponse) ?? {};
      const receiptStatus = String(result.receipt?.status ?? "");

      if (receiptStatus === "needs_approval") {
        // Needs approval – show immediately, no polling
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result, runStatus: "needs_approval" } }));
      } else if (result.runId) {
        // Queued – start polling for actual result
        void pollRunResult(execKey, result.runId, result);
      } else {
        // Fallback (no runId) – show as done
        setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "done", result } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToolExecStates((prev) => ({ ...prev, [execKey]: { status: "error", message: msg } }));
    }
  }, [locale, pollRunResult]);

  /* ─── NL2UI card click → open note in workspace (or drill-down) ─── */
  const handleCardClick = useCallback((card: { title: string; id?: string; [key: string]: any }) => {
    if (!card.title) return;
    if (card.id) {
      const noteUrl = `/notes/${encodeURIComponent(card.id)}?lang=${encodeURIComponent(locale)}`;
      openInWorkspace({ kind: "page", name: card.title, url: noteUrl });
      setRecent(addRecent({ kind: "page", name: card.title }));
    } else {
      const msg = `${t(locale, "chat.openNote")} ${card.title}`;
      void send(msg);
    }
  }, [locale, send, openInWorkspace]);

  /* ─── key handler ─── */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  }, [send]);

  /* ──────────────────── RENDER ──────────────────────────────────────────── */

  return (
    <div className={`${styles.page} ${hasMessages ? styles.chatMode : ""}`}>
      {/* ── Top bar ── */}
      <header className={styles.topBar}>
        <Link href={`/?lang=${encodeURIComponent(locale)}`} className={styles.brand}>{t(locale, "app.title")}</Link>
        <div className={styles.topRight}>
          {/* Docs link */}
          <Link href={`/docs?lang=${encodeURIComponent(locale)}`} className={styles.newChatBtn} style={{ textDecoration: "none" }}>
            {t(locale, "shell.nav.docs")}
          </Link>
          {/* Ctrl+K trigger */}
          <button className={styles.newChatBtn} onClick={() => setCmdOpen(true)} title={t(locale, "cmdPalette.hint")}>
            <IconSearch /><kbd className={styles.cmdKbd}>Ctrl K</kbd>
          </button>
          {hasMessages && (
            <button className={styles.newChatBtn} onClick={startNew} disabled={busy}>
              {t(locale, "chat.session.new")}
            </button>
          )}
          <Link href={`/?lang=zh-CN`} className={locale === "zh-CN" ? styles.langActive : undefined}>{t(locale, "lang.zh")}</Link>
          <span className={styles.langDivider}>/</span>
          <Link href={`/?lang=en-US`} className={locale === "en-US" ? styles.langActive : undefined}>{t(locale, "lang.en")}</Link>
        </div>
      </header>

      {/* ── Split container (left panel + divider + right chat) ── */}
      <div className={`${styles.splitContainer} ${layoutMounted ? styles.splitMounted : styles.splitHidden}`} ref={splitRef}>
        {/* ── Left Content Panel ── */}
        <div
          className={`${styles.panelSide} ${leftCollapsed ? styles.panelCollapsed : ""}`}
          style={leftCollapsed ? undefined : rightCollapsed ? { flex: 1 } : { width: `${leftWidth}%` }}
        >
          {/* Collapse toggle for left panel */}
          {!leftCollapsed && (
            <button
              className={`${styles.collapseBtn} ${styles.collapseBtnLeft}`}
              onClick={toggleLeft}
              title={t(locale, "panel.collapseLeft")}
            >
              <IconChevronLeft />
            </button>
          )}

          {/* Tab bar */}
          {(pinnedTabs.length > 0 || previewTab) && (
            <div className={styles.wsTabs}>
              <div className={styles.wsTabList}>
                {pinnedTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`${styles.wsTab} ${activeTabId === tab.id ? styles.wsTabActive : ""}`}
                    onClick={() => setActiveTabId(tab.id)}
                    title={tab.name}
                  >
                    <span className={styles.wsTabLabel}>{tab.name}</span>
                    <span className={styles.wsTabClose} onClick={(e) => { e.stopPropagation(); unpinTab(tab.id); }} title={t(locale, "workspace.unpin")}>×</span>
                  </button>
                ))}
                {previewTab && (
                  <button
                    className={`${styles.wsTab} ${styles.wsTabPreview} ${activeTabId === "__preview__" ? styles.wsTabActive : ""}`}
                    onClick={() => setActiveTabId("__preview__")}
                    title={`${t(locale, "workspace.preview")}: ${previewTab.name}`}
                  >
                    <span className={styles.wsTabLabel} style={{ fontStyle: "italic" }}>{previewTab.name}</span>
                    <span className={styles.wsTabPin} onClick={(e) => { e.stopPropagation(); pinCurrentPreview(); }} title={t(locale, "workspace.pin")}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v10m0 0-3-3m3 3 3-3M5 17h14" /></svg>
                    </span>
                    <span className={styles.wsTabClose} onClick={(e) => { e.stopPropagation(); closePreview(); }} title={t(locale, "panel.close")}>×</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Content area */}
          {visibleTab ? (
            <>
              <div className={styles.panelHeader}>
                <span className={styles.panelTitle}>{visibleTab.name}</span>
                <div className={styles.panelActions}>
                  {activeTabId === "__preview__" && previewTab && (
                    <button
                      className={styles.panelIconBtn}
                      title={t(locale, "workspace.pin")}
                      onClick={pinCurrentPreview}
                      style={{ color: "var(--sl-accent)" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                    </button>
                  )}
                  <button
                    className={styles.panelIconBtn}
                    title={t(locale, "panel.openNewTab")}
                    onClick={() => router.push(visibleTab.url)}
                  >
                    <IconExternal />
                  </button>
                  <button className={styles.panelIconBtn} title={t(locale, "panel.close")} onClick={closePanel}>
                    <IconClose />
                  </button>
                </div>
              </div>
              <iframe className={styles.panelFrame} src={visibleTab.url} title={visibleTab.name} sandbox="allow-scripts allow-same-origin" />
            </>
          ) : (
            <div className={styles.panelEmpty}>
              <div className={styles.panelEmptyIcon}>
                <IconPage />
              </div>
              <div className={styles.panelEmptyTitle}>{t(locale, "panel.emptyTitle")}</div>
              <div className={styles.panelEmptyDesc}>{t(locale, "panel.emptyDesc")}</div>
              {recent.length > 0 && (
                <div className={styles.panelEmptyActions}>
                  {recent.slice(0, 4).map((r, i) => (
                    <button key={`${r.kind}_${r.name}_${i}`} className={styles.suggestChip} onClick={() => openRecentInPanel(r)}>
                      {r.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Resize Divider ── */}
        {!leftCollapsed && !rightCollapsed && (
          <div
            className={`${styles.resizeDivider} ${isDragging ? styles.resizeDividerActive : ""}`}
            onMouseDown={handleDragStart}
          />
        )}

        {/* Expand button when left is collapsed */}
        {leftCollapsed && (
          <button
            className={`${styles.collapseBtn}`}
            style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "0 6px 6px 0", flexShrink: 0 }}
            onClick={toggleLeft}
            title={t(locale, "panel.expandLeft")}
          >
            <IconChevronRight />
          </button>
        )}

        {/* Expand button when right is collapsed */}
        {rightCollapsed && (
          <button
            className={`${styles.collapseBtn}`}
            style={{ position: "relative", top: "auto", transform: "none", alignSelf: "center", borderRadius: "6px 0 0 6px", flexShrink: 0 }}
            onClick={toggleRight}
            title={t(locale, "panel.expandRight")}
          >
            <IconChevronLeft />
          </button>
        )}

        {/* ── Right Chat Side ── */}
        <div className={`${styles.chatSide} ${rightCollapsed ? styles.chatCollapsed : ""}`}>
          {/* Collapse toggle for right chat */}
          {!rightCollapsed && (
            <button
              className={`${styles.collapseBtn} ${styles.collapseBtnRight}`}
              onClick={toggleRight}
              title={t(locale, "panel.collapseRight")}
            >
              <IconChevronRight />
            </button>
          )}
          <main className={styles.main}>
            {/* Welcome (only when empty) */}
            {!hasMessages && (
              <div className={styles.hero}>
                <h1 className={styles.greeting}>{t(locale, "home.welcome")}</h1>
                <p className={styles.subtitle}>{t(locale, "home.subtitle")}</p>
                <p className={styles.hint} style={{ marginTop: 8 }}>{t(locale, "nl2ui.description")}</p>
              </div>
            )}

            {/* Chat flow */}
            {hasMessages && (
              <div className={styles.chatFlow} ref={scrollRef}>
                {flow.map((it) => {
                  const isUser = it.kind === "message" && it.role === "user";
                  return (
                    <div key={it.id} className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant} ${it.kind === "error" ? styles.bubbleError : ""} ${it.kind === "nl2uiResult" ? styles.bubbleNl2ui : ""} ${it.kind === "toolSuggestions" ? styles.bubbleToolSuggestion : ""}`}>
                      {it.kind === "message" && (
                        <div className={styles.bubbleText}>
                          {isUser ? it.text : <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>}
                        </div>
                      )}
                      {it.kind === "error" && (() => {
                        const isNl2uiError = String(it.errorCode ?? "").startsWith("NL2UI_");
                        return (
                        <div className={styles.bubbleText}>
                          {isNl2uiError
                            ? <>{it.message || t(locale, "chat.nl2ui.error.default")}</>
                            : <>{friendlyErrorMessage(locale, it.errorCode, it.message)}</>}
                          {it.traceId ? <span className={styles.traceId}>{t(locale, "chat.requestId")}{it.traceId}</span> : null}
                          {it.retryMessage ? (
                            <div className={styles.inlineBtnGroup}>
                              <button className={styles.inlineBtn} onClick={() => void send(it.retryMessage, { appendUser: false })} disabled={busy}>
                                {t(locale, "runs.action.retry")}
                              </button>
                            </div>
                          ) : null}
                        </div>
                        );
                      })()}
                      {it.kind === "toolSuggestions" && (
                        <div className={styles.bubbleText}>
                          <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(locale, "chat.toolSuggestion.title")}</div>
                          {it.suggestions.map((s, idx) => {
                            const toolRef = String(s.toolRef ?? "").trim();
                            const risk = String(s.riskLevel ?? "low").trim();
                            const approval = Boolean(s.approvalRequired);
                            const execKey = `${it.id}_${idx}`;
                            const execState = toolExecStates[execKey] ?? { status: "idle" };
                            const doneRunStatus = execState.status === "done" ? (execState.runStatus ?? String(execState.result?.receipt?.status ?? "")) : "";
                            return (
                              <div key={execKey} className={styles.toolSuggestionCard}>
                                <div className={styles.toolSuggestionHeader}>
                                  <span className={styles.toolSuggestionName}>{friendlyToolName(locale, toolRef)}</span>
                                  <span className={`${styles.toolSuggestionBadge} ${riskBadgeClass(risk, styles)}`}>
                                    {t(locale, riskBadgeKey(risk))}
                                  </span>
                                  <span className={`${styles.toolSuggestionBadge} ${styles.toolSuggestionBadgeApproval}`}>
                                    {t(locale, approval ? "chat.toolSuggestion.needsApproval" : "chat.toolSuggestion.noApproval")}
                                  </span>
                                </div>
                                {s.inputDraft != null && (
                                  <div className={styles.toolSuggestionInput}>
                                    <div className={styles.toolSuggestionInputLabel}>{t(locale, "chat.toolSuggestion.inputLabel")}</div>
                                    <pre className={styles.toolSuggestionInputPre}>{safeJsonString(s.inputDraft)}</pre>
                                  </div>
                                )}
                                <div className={styles.toolSuggestionActions}>
                                  {execState.status === "idle" && toolRef && (
                                    <button
                                      className={styles.toolExecBtn}
                                      onClick={() => void executeToolInline(it.id, idx, s)}
                                    >
                                      {t(locale, "chat.toolSuggestion.execute")}
                                    </button>
                                  )}
                                  {execState.status === "executing" && (
                                    <button className={styles.toolExecBtn} disabled>
                                      {t(locale, "chat.toolSuggestion.executing")}
                                    </button>
                                  )}
                                  <Link className={styles.inlineBtn} href={`/orchestrator?lang=${encodeURIComponent(locale)}`}>
                                    <IconExternal /> {t(locale, "chat.toolSuggestion.viewDetail")}
                                  </Link>
                                </div>
                                {execState.status === "polling" && (
                                  <div className={styles.toolExecPolling}>
                                    {t(locale, "chat.toolSuggestion.polling")}
                                    {execState.runStatus && execState.runStatus !== "queued" && (
                                      <span style={{ marginLeft: 4, fontWeight: 500 }}>
                                        ({t(locale, `chat.toolSuggestion.runStatus.${execState.runStatus}`)})
                                      </span>
                                    )}
                                  </div>
                                )}
                                {execState.status === "done" && (
                                  <>
                                    <div className={`${styles.toolExecResult} ${
                                      doneRunStatus === "needs_approval" ? styles.toolExecResultQueued
                                      : doneRunStatus === "queued" ? styles.toolExecResultQueued
                                      : doneRunStatus === "failed" || doneRunStatus === "canceled" || doneRunStatus === "deadletter" ? styles.toolExecResultFailed
                                      : styles.toolExecResultSuccess
                                    }`}>
                                      {doneRunStatus === "needs_approval"
                                        ? t(locale, "chat.toolSuggestion.resultApproval")
                                        : doneRunStatus === "queued"
                                          ? t(locale, "chat.toolSuggestion.resultQueued")
                                          : doneRunStatus === "failed" || doneRunStatus === "deadletter"
                                            ? t(locale, "chat.toolSuggestion.runStatus.failed")
                                            : doneRunStatus === "canceled"
                                              ? t(locale, "chat.toolSuggestion.runStatus.canceled")
                                              : t(locale, "chat.toolSuggestion.runStatus.succeeded")}
                                      {execState.result?.runId && (
                                        <span style={{ marginLeft: 8 }}>
                                          <Link className={styles.inlineLink} href={`/runs/${encodeURIComponent(execState.result.runId)}?lang=${encodeURIComponent(locale)}`}>
                                            {t(locale, "orchestrator.playground.openRun")}
                                          </Link>
                                        </span>
                                      )}
                                    </div>
                                    {doneRunStatus === "succeeded" && (() => {
                                      const summary = friendlyOutputSummary(locale, toolRef, execState.stepOutput);
                                      return (
                                        <div className={styles.toolExecSummary}>
                                          <div className={styles.toolExecSummaryText}>{summary.text}</div>
                                          {summary.latencyMs != null && (
                                            <div className={styles.toolExecSummaryMeta}>
                                              <span>{t(locale, "chat.toolSuggestion.latency")} {(summary.latencyMs / 1000).toFixed(1)}s</span>
                                            </div>
                                          )}
                                          {execState.result?.runId && (
                                            <div className={styles.toolExecSummaryLink}>
                                              <Link className={styles.inlineLink} href={`/runs/${encodeURIComponent(execState.result.runId)}?lang=${encodeURIComponent(locale)}`}>
                                                {t(locale, "chat.toolSuggestion.viewRun")}
                                              </Link>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                    {(doneRunStatus === "failed" || doneRunStatus === "deadletter") && execState.stepError && (
                                      <div className={styles.toolExecOutputWrap}>
                                        <div className={styles.toolExecOutputLabel}>{t(locale, "chat.toolSuggestion.errorDetail")}</div>
                                        <pre className={styles.toolExecOutputPre}>{execState.stepError}</pre>
                                      </div>
                                    )}
                                  </>
                                )}
                                {execState.status === "error" && (
                                  <div className={`${styles.toolExecResult} ${styles.toolExecResultFailed}`}>
                                    {t(locale, "chat.toolSuggestion.resultFailed")}: {execState.message}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {it.kind === "uiDirective" && (
                        <div className={styles.bubbleText}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(locale, "chat.uiDirective.title")}</div>
                          <pre className={styles.preBlock}>{safeJsonString(it.directive)}</pre>
                          {it.target && directiveNav[it.id]?.status === "allowed" && (
                            <div className={styles.inlineBtnGroup}>
                              <button className={styles.inlineBtn} onClick={() => void openDirective(it, "panel")}>
                                <IconPanel /> {t(locale, "panel.openInPanel")}
                              </button>
                              <button className={styles.inlineBtn} onClick={() => void openDirective(it, "navigate")}>
                                <IconExternal /> {it.target.kind === "page" ? t(locale, "chat.uiDirective.openPage") : t(locale, "chat.uiDirective.openWorkbench")}
                              </button>
                            </div>
                          )}
                          {it.target && directiveNav[it.id]?.status === "blocked" && (
                            <span className={styles.hint}>{(directiveNav[it.id] as { hint: string }).hint}</span>
                          )}
                          {it.target && directiveNav[it.id]?.status === "checking" && (
                            <span className={styles.hint}>{t(locale, "chat.uiDirective.checking")}</span>
                          )}
                        </div>
                      )}
                      {it.kind === "nl2uiResult" && (
                        <div className={styles.nl2uiResultCard}>
                          {/* Meta */}
                          <div className={styles.nl2uiMeta}>
                            <span className={styles.badge}>{t(locale, "nl2ui.confidence")} {it.config.metadata?.confidence ?? "-"}</span>
                            <button
                              className={styles.nl2uiMaximizeBtn}
                              onClick={() => setMaximizedNl2ui(it)}
                              title={t(locale, "nl2ui.maximize")}
                            >
                              <IconMaximize /> {t(locale, "nl2ui.maximize")}
                            </button>
                          </div>
                          {/* Render */}
                          <div className={styles.nl2uiPreview}>
                            <DynamicBlockRenderer config={it.config} readOnly={!it.config.dataBindings?.length} locale={locale} onCardClick={handleCardClick} />
                          </div>
                          {/* Save as page */}
                          <div className={styles.nl2uiSuggestions}>
                            {savedPages[it.id] ? (
                              <Link
                                className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
                                href={`${savedPages[it.id].pageUrl}?lang=${encodeURIComponent(locale)}`}
                              >
                                {t(locale, "nl2ui.savedOpen")}
                              </Link>
                            ) : (
                              <button
                                className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
                                onClick={() => void saveAsPage(it.id, it.config, it.userInput)}
                                disabled={savingPageId === it.id}
                              >
                                {savingPageId === it.id
                                  ? t(locale, "nl2ui.saving")
                                  : t(locale, "nl2ui.saveAsPage")}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {busy && nl2uiLoading && (
                  <div className={styles.nl2uiSkeleton}>
                    <div className={styles.nl2uiSkeletonHeader}>
                      <div className={styles.nl2uiSkeletonBar} style={{ width: 60 }} />
                      <div className={styles.nl2uiSkeletonBar} style={{ width: 48 }} />
                      <div className={styles.nl2uiSkeletonBar} style={{ width: 72 }} />
                    </div>
                    <div className={styles.nl2uiSkeletonBody}>
                      <div className={styles.nl2uiSkeletonRow}>
                        <div className={styles.nl2uiSkeletonCell} />
                        <div className={styles.nl2uiSkeletonCell} />
                        <div className={styles.nl2uiSkeletonCell} />
                      </div>
                      <div className={styles.nl2uiSkeletonRow}>
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                      </div>
                      <div className={styles.nl2uiSkeletonRow}>
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                        <div className={styles.nl2uiSkeletonCell} style={{ height: 24 }} />
                      </div>
                    </div>
                    <div className={styles.nl2uiSkeletonLabel}>
                      <span className={styles.nl2uiSkeletonDot} />
                      {t(locale, "nl2ui.generating")}
                    </div>
                  </div>
                )}
                {busy && !nl2uiLoading && <div className={styles.typing}><span /><span /><span /></div>}
              </div>
            )}

            {/* Input box */}
            <div className={`${styles.inputBox} ${hasMessages ? styles.inputBoxDocked : ""}`}>
              <textarea
                ref={inputRef}
                className={styles.inputArea}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t(locale, hasMessages ? "chat.composer.placeholder" : "home.inputPlaceholder")}
                rows={hasMessages ? 1 : 3}
                disabled={busy}
                onKeyDown={onKeyDown}
              />
              <button className={styles.sendBtn} onClick={() => void send()} disabled={!canSend}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" />
                </svg>
              </button>
            </div>

            {/* Quick nav + Recent (only when empty) */}
            {!hasMessages && (
              <>
                <nav className={styles.quickNav}>
                  {NAV_ITEMS.map((n) => (
                    <Link key={n.key} className={styles.navPill} href={q(n.href)}>
                      {t(locale, `home.quickNav.${n.key}`)}
                    </Link>
                  ))}
                </nav>

                {/* Recent navigation */}
                {recent.length > 0 && (
                  <div className={styles.recentNav}>
                    <div className={styles.recentHeader}>
                      <span className={styles.recentTitle}>{t(locale, "recentNav.title")}</span>
                      <button className={styles.recentClearBtn} onClick={handleClearRecent}>{t(locale, "recentNav.clear")}</button>
                    </div>
                    <div className={styles.recentList}>
                      {recent.slice(0, 8).map((r, i) => (
                        <button key={`${r.kind}_${r.name}_${i}`} className={styles.recentItem} onClick={() => openRecentInPanel(r)}>
                          <span className={styles.recentKind}>{t(locale, r.kind === "page" ? "recentNav.page" : "recentNav.workbench")}</span>
                          {r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {/* ── NL2UI Maximized Overlay ── */}
      {maximizedNl2ui && (
        <div className={styles.nl2uiOverlay}>
          <div className={styles.nl2uiOverlayHeader}>
            <div className={styles.nl2uiOverlayMeta}>
              <span className={styles.badge}>{t(locale, "nl2ui.confidence")} {maximizedNl2ui.config.metadata?.confidence ?? "-"}</span>
            </div>
            <div className={styles.nl2uiOverlayActions}>
              {/* Save as page */}
              {savedPages[maximizedNl2ui.id] ? (
                <Link
                  className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
                  href={`${savedPages[maximizedNl2ui.id].pageUrl}?lang=${encodeURIComponent(locale)}`}
                >
                  {t(locale, "nl2ui.savedOpen")}
                </Link>
              ) : (
                <button
                  className={`${styles.suggestChip} ${styles.suggestChipPrimary}`}
                  onClick={() => void saveAsPage(maximizedNl2ui.id, maximizedNl2ui.config, maximizedNl2ui.userInput)}
                  disabled={savingPageId === maximizedNl2ui.id}
                >
                  {savingPageId === maximizedNl2ui.id
                    ? t(locale, "nl2ui.saving")
                    : t(locale, "nl2ui.saveAsPage")}
                </button>
              )}
              <button
                className={styles.nl2uiOverlayCloseBtn}
                onClick={() => setMaximizedNl2ui(null)}
                title={t(locale, "nl2ui.restore")}
              >
                <IconMinimize /> {t(locale, "nl2ui.restore")}
              </button>
            </div>
          </div>
          <div className={styles.nl2uiOverlayBody}>
            <DynamicBlockRenderer config={maximizedNl2ui.config} readOnly={!maximizedNl2ui.config.dataBindings?.length} locale={locale} enableLayoutEdit={true} onCardClick={(card) => { setMaximizedNl2ui(null); handleCardClick(card); }} />
          </div>
        </div>
      )}

      {/* ── Command Palette ── */}
      <CommandPalette
        locale={locale}
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onSelect={handleCmdSelect}
        recent={recent}
      />
    </div>
  );
}
