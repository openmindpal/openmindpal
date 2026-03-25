import { text } from "./api";

/**
 * Shared API error types and helpers.
 * Replaces per-page duplicated definitions across the codebase.
 */

export type ApiError = { errorCode?: string; message?: unknown; traceId?: string; dimension?: string; retryAfterSec?: number };

export function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

export function errText(locale: string, e: ApiError | null | undefined) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object"
      ? text(msgVal as Record<string, string>, locale)
      : msgVal != null
        ? String(msgVal)
        : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export function errorMessageText(locale: string, v: unknown) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) return text(v as Record<string, string>, locale);
  return String(v);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function safeJsonString(v: unknown) {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return "null";
  }
}

export function nextId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
