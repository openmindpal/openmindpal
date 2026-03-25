/**
 * HomeChat — shared types, constants & pure helpers.
 * Extracted from HomeChat.tsx to keep the main component lean.
 */

import { t } from "@/lib/i18n";
import { isPlainObject } from "@/lib/apiError";
import { type ToolSuggestion, type ExecuteResponse } from "@/lib/types";
import { type Nl2UiConfig } from "@/components/nl2ui/DynamicBlockRenderer";

/* ─── Flow types ─────────────────────────────────────────────────────── */

export type FlowMessage = { id: string; role: "user" | "assistant"; text: string };
export type FlowError = { id: string; role: "assistant"; errorCode: string; message: string; traceId: string; retryMessage?: string };
export type UiDirectiveTarget = { kind: "page"; name: string } | { kind: "workbench"; key: string };
export type FlowDirective = { id: string; role: "assistant"; kind: "uiDirective"; directive: unknown; target: UiDirectiveTarget | null };
export type FlowNl2UiResult = {
  id: string; role: "assistant"; kind: "nl2uiResult";
  config: Nl2UiConfig;
  userInput: string;
  suggestions: string[];
};
export type FlowToolSuggestions = { id: string; role: "assistant"; kind: "toolSuggestions"; suggestions: ToolSuggestion[]; turnId?: string };

export type WorkspaceTab = { id: string; kind: "page" | "workbench"; name: string; url: string };

export type ToolExecState =
  | { status: "idle" }
  | { status: "executing" }
  | { status: "polling"; runId: string; runStatus?: string }
  | { status: "done"; result: ExecuteResponse; runStatus?: string; stepOutput?: unknown; stepError?: string }
  | { status: "error"; message: string };

export type ChatFlowItem =
  | ({ kind: "message" } & FlowMessage)
  | ({ kind: "error" } & FlowError)
  | FlowDirective
  | FlowNl2UiResult
  | FlowToolSuggestions;

/* ─── Constants ──────────────────────────────────────────────────────── */

/** Terminal run statuses – stop polling when we see one of these */
export const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled", "deadletter"]);

export const NAV_ITEMS = [
  { key: "runs", href: "/runs" },
  { key: "tasks", href: "/tasks" },
  { key: "orchestrator", href: "/orchestrator" },
  { key: "governance", href: "/gov/changesets" },
  { key: "settings", href: "/settings" },
] as const;

/* ─── Recent pages (localStorage) ────────────────────────────────────── */

export type RecentEntry = { kind: "page" | "workbench"; name: string; ts: number };
const RECENT_KEY = "openslin_recent_pages";
const MAX_RECENT = 12;

export function loadRecent(): RecentEntry[] {
  try { const raw = localStorage.getItem(RECENT_KEY); return raw ? (JSON.parse(raw) as RecentEntry[]) : []; }
  catch { return []; }
}

export function addRecent(entry: Omit<RecentEntry, "ts">) {
  const list = loadRecent().filter((r) => !(r.kind === entry.kind && r.name === entry.name));
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  return list;
}

export function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY); } catch {}
}

/* ─── Tool helpers ───────────────────────────────────────────────────── */

export function parseToolRef(toolRef: string) {
  const idx = toolRef.lastIndexOf("@");
  const name = idx > 0 ? toolRef.slice(0, idx) : toolRef;
  const version = idx > 0 ? toolRef.slice(idx + 1) : "";
  return { name, version };
}

export function friendlyToolName(locale: string, toolRef: string): string {
  const { name } = parseToolRef(toolRef);
  const key = `chat.toolSuggestion.toolName.${name}`;
  const label = t(locale, key);
  return label !== key ? label : name;
}

export function riskBadgeKey(risk: string): string {
  const r = risk.toLowerCase();
  if (r === "low") return "chat.toolSuggestion.risk.low";
  if (r === "medium" || r === "med") return "chat.toolSuggestion.risk.medium";
  if (r === "high") return "chat.toolSuggestion.risk.high";
  return "chat.toolSuggestion.risk.low";
}

export function friendlyOutputSummary(locale: string, toolRef: string, outputDigest: unknown): { text: string; latencyMs?: number } {
  const toolName = friendlyToolName(locale, toolRef);
  const text = t(locale, "chat.toolSuggestion.outputSummary").replace("{tool}", toolName);
  const latencyMs = isPlainObject(outputDigest) && typeof (outputDigest as any).latencyMs === "number" ? (outputDigest as any).latencyMs as number : undefined;
  return { text, latencyMs };
}

/** Convert technical error codes into user-friendly messages. */
export function friendlyErrorMessage(locale: string, errorCode: string, message?: string): string {
  const code = String(errorCode ?? "").trim();
  if (code) {
    const key = `chat.error.${code}`;
    const mapped = t(locale, key);
    if (mapped !== key) return mapped;
  }
  if (message) return message;
  return t(locale, "chat.error.unknown");
}

export function targetFromUiDirective(d: unknown): UiDirectiveTarget | null {
  if (!isPlainObject(d)) return null;
  const viewParams = d.viewParams;
  if (!isPlainObject(viewParams)) return null;
  if (d.openView === "page") { const n = viewParams.name; if (typeof n !== "string" || !n.trim()) return null; return { kind: "page", name: n.trim() }; }
  if (d.openView === "workbench") { const k = (viewParams.key ?? viewParams.workbenchKey); const key = typeof k === "string" ? k.trim() : ""; if (!key) return null; return { kind: "workbench", key }; }
  return null;
}

/**
 * riskBadgeClass needs CSS module reference — pass the styles object.
 * Returns the appropriate badge CSS class for the given risk level.
 */
export function riskBadgeClass(risk: string, cssStyles: Record<string, string>): string {
  const r = risk.toLowerCase();
  if (r === "medium" || r === "med") return cssStyles.toolSuggestionBadgeMedium;
  if (r === "high") return cssStyles.toolSuggestionBadgeHigh;
  return cssStyles.toolSuggestionBadgeLow;
}
