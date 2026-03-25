import { Errors } from "../../../lib/errors";
import { openaiCompatibleProviders } from "./catalog";

export type OutputSchemaFieldType = "string" | "number" | "boolean" | "json" | "datetime";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

export function getAllowedDomains(params: { connectorEgressPolicy: any; typeDefaultEgressPolicy: any }) {
  const p = params.connectorEgressPolicy ?? params.typeDefaultEgressPolicy ?? {};
  const a = Array.isArray(p.allowedDomains) ? p.allowedDomains.filter((x: any) => typeof x === "string" && x.length) : [];
  return a as string[];
}

export function isModelUpstreamError(err: unknown) {
  return Boolean(err && typeof err === "object" && "errorCode" in err && (err as any).errorCode === "MODEL_UPSTREAM_FAILED");
}

export function normalizeBaseUrl(input: unknown, fallbackScheme: "http" | "https" = "https") {
  const s = String(input ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `${fallbackScheme}://${s}`;
}

export function getHostFromBaseUrl(baseUrl: string) {
  const u = new URL(baseUrl);
  return u.hostname;
}

export function normalizeAllowedDomains(v: unknown) {
  const arr = Array.isArray(v) ? v : [];
  const out = arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"));
  return Array.from(new Set(out));
}

export function dlpRuleIdsFromSummary(summary: { hitCounts?: Record<string, number> }) {
  const hitCounts = summary?.hitCounts ?? {};
  const out: string[] = [];
  if ((hitCounts.token ?? 0) > 0) out.push("dlp.token");
  if ((hitCounts.email ?? 0) > 0) out.push("dlp.email");
  if ((hitCounts.phone ?? 0) > 0) out.push("dlp.phone");
  return out;
}

export function hasDlpEnvOverride(env: NodeJS.ProcessEnv = process.env) {
  const mode = String(env.DLP_MODE ?? "").trim();
  const targets = String(env.DLP_DENY_TARGETS ?? "").trim();
  const hitTypes = String(env.DLP_DENY_HIT_TYPES ?? "").trim();
  return Boolean(mode || targets || hitTypes);
}

export function isOpenAiCompatibleProvider(provider: string) {
  return (openaiCompatibleProviders as readonly string[]).includes(provider);
}

export function parseProviderModelRef(modelRef: string) {
  const m = /^([a-z0-9_]+):(.+)$/.exec(String(modelRef ?? "").trim().toLowerCase());
  if (!m) return null;
  const provider = m[1];
  const model = String(modelRef ?? "").trim().slice(provider.length + 1);
  if (!provider || !model) return null;
  return { provider, model };
}

export function normalizeOpenAiCompatibleBaseUrl(input: unknown) {
  const base = normalizeBaseUrl(input, "https");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw Errors.badRequest("baseUrl 非法");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Errors.badRequest("baseUrl 协议不支持");
  u.search = "";
  u.hash = "";
  let out = u.toString().replace(/\/+$/g, "");
  out = out.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/g, "");
  out = out.replace(/\/v1\/chat\/completions\/?$/i, "/v1").replace(/\/+$/g, "");
  return out;
}

export function normalizeChatCompletionsPath(input: unknown) {
  if (input === null || input === undefined) return null;
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.includes("://")) throw Errors.badRequest("chatCompletionsPath 必须是相对路径");
  return raw.startsWith("/") ? raw : `/${raw}`;
}
