export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

export const AUTH_TOKEN_KEY = "openslin_token";

function readCookieValue(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const parts = document.cookie.split(";").map((x) => x.trim());
  for (const p of parts) {
    if (!p.startsWith(prefix)) continue;
    const raw = p.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return "";
}

export function getClientAuthToken() {
  if (typeof window === "undefined") return "";
  // Read exclusively from cookie (not localStorage) to reduce XSS token exposure.
  const c = readCookieValue(AUTH_TOKEN_KEY);
  return c && c.trim() ? c.trim() : "";
}

export function setClientAuthToken(token: string) {
  const v = token.trim();
  // Migrate: remove stale localStorage entry if present.
  if (typeof window !== "undefined") {
    try { window.localStorage.removeItem(AUTH_TOKEN_KEY); } catch { /* ignore */ }
  }
  // Store token exclusively in cookie with SameSite=Strict.
  if (typeof document !== "undefined") {
    const encoded = encodeURIComponent(v);
    if (!v) {
      document.cookie = `${encodeURIComponent(AUTH_TOKEN_KEY)}=; path=/; max-age=0`;
      return;
    }
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${encodeURIComponent(AUTH_TOKEN_KEY)}=${encoded}; path=/; max-age=31536000; SameSite=Strict${secure}`;
  }
}

export function apiHeaders(locale: string, opts?: { token?: string | null; tenantId?: string | null; spaceId?: string | null }) {
  const rawToken = (opts?.token ?? (typeof window !== "undefined" ? getClientAuthToken() : "") ?? "").trim();
  const headers: Record<string, string> = {
    "x-user-locale": locale,
    "x-schema-name": "core",
  };
  const tenantId = (opts?.tenantId ?? "").trim();
  if (tenantId) headers["x-tenant-id"] = tenantId;
  const spaceId = (opts?.spaceId ?? "").trim();
  if (spaceId) headers["x-space-id"] = spaceId;
  if (rawToken) {
    const lower = rawToken.toLowerCase();
    const authValue = lower.startsWith("bearer ") || lower.startsWith("device ") ? rawToken : `Bearer ${rawToken}`;
    headers.authorization = authValue;
  }
  return headers;
}

export function pickLocale(searchParams: Record<string, string | string[] | undefined>) {
  const v = searchParams.lang;
  const lang = Array.isArray(v) ? v[0] : v;
  return lang || "zh-CN";
}

/** Persist locale preference to cookie + update <html lang> for accessibility */
export function setLocale(locale: string) {
  if (typeof document !== "undefined") {
    document.cookie = `openslin_locale=${encodeURIComponent(locale)}; path=/; max-age=31536000`;
    document.documentElement.lang = locale;
  }
}

export type I18nText = Record<string, string>;

/** Default timeout for server-side (SSR) fetch calls to prevent first-paint blocking (§02§5.4) */
export const SSR_TIMEOUT_MS = 5_000;

export function text(text: I18nText | string | undefined, locale: string) {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text["zh-CN"] ?? Object.values(text)[0] ?? "";
}

/* ─── Unified fetch wrapper with 401/403 interception (§02§5.4) ──── */

let _globalLocale = "zh-CN";
export function setGlobalLocale(l: string) { _globalLocale = l; }

/**
 * Wrapper around fetch that automatically injects auth headers,
 * generates traceId, and intercepts 401 responses.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit & { locale?: string; token?: string; tenantId?: string; spaceId?: string; idempotencyKey?: string },
): Promise<Response> {
  const locale = init?.locale ?? _globalLocale;
  const hdrs = apiHeaders(locale, { token: init?.token ?? null, tenantId: init?.tenantId ?? null, spaceId: init?.spaceId ?? null });

  /* Merge caller headers */
  const incoming = init?.headers;
  if (incoming) {
    const entries = incoming instanceof Headers
      ? Array.from(incoming.entries())
      : Array.isArray(incoming) ? incoming : Object.entries(incoming);
    for (const [k, v] of entries) hdrs[k] = v;
  }

  /* Inject traceId for observability (§06) */
  if (!hdrs["x-trace-id"]) {
    hdrs["x-trace-id"] = typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function"
      ? (crypto as any).randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /* Inject idempotency key for write operations (§02§5.3) */
  if (init?.idempotencyKey) hdrs["idempotency-key"] = init.idempotencyKey;

  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  const res = await fetch(url, { ...init, headers: hdrs });

  /* 401 → clear token & redirect to root (§05) */
  if (res.status === 401 && typeof window !== "undefined") {
    setClientAuthToken("");
    window.location.href = `/?lang=${encodeURIComponent(locale)}`;
  }

  return res;
}
