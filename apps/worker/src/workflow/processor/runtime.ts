import { isPlainObject } from "./common";

export type RuntimeLimits = {
  timeoutMs: number;
  maxConcurrency: number;
  memoryMb: number | null;
  cpuMs: number | null;
  maxOutputBytes: number;
  maxEgressRequests: number;
};

export type NetworkPolicyRule = {
  host: string;
  pathPrefix?: string;
  methods?: string[];
};

export type NetworkPolicy = {
  allowedDomains: string[];
  rules: NetworkPolicyRule[];
};

export type EgressEvent = {
  host: string;
  method: string;
  allowed: boolean;
  policyMatch?: { kind: "allowedDomain" | "rule"; rulePathPrefix?: string; ruleMethods?: string[] };
  status?: number;
  errorCategory?: string;
};

export type EgressCheck =
  | { allowed: true; host: string; method: string; reason: null; match: { kind: "allowedDomain" | "rule"; rulePathPrefix?: string; ruleMethods?: string[] } }
  | { allowed: false; host: string; method: string; reason: string };

const concurrencyCounters = new Map<string, number>();

export function normalizeLimits(v: unknown): RuntimeLimits {
  const obj = isPlainObject(v) ? v : {};
  const timeoutMs = typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0 ? obj.timeoutMs : 10_000;
  const maxConcurrency =
    typeof obj.maxConcurrency === "number" && Number.isFinite(obj.maxConcurrency) && obj.maxConcurrency > 0 ? obj.maxConcurrency : 10;
  const memoryMbRaw = typeof obj.memoryMb === "number" && Number.isFinite(obj.memoryMb) ? obj.memoryMb : null;
  const memoryMb = memoryMbRaw === null ? null : Math.max(32, Math.min(8192, Math.round(memoryMbRaw)));
  const cpuMsRaw = typeof obj.cpuMs === "number" && Number.isFinite(obj.cpuMs) ? obj.cpuMs : null;
  const cpuMs = cpuMsRaw === null ? null : Math.max(50, Math.min(10_000, Math.round(cpuMsRaw)));
  const maxOutputBytesRaw = typeof obj.maxOutputBytes === "number" && Number.isFinite(obj.maxOutputBytes) ? obj.maxOutputBytes : null;
  const maxOutputBytes = maxOutputBytesRaw === null ? 1_000_000 : Math.max(1_000, Math.min(20_000_000, Math.round(maxOutputBytesRaw)));
  const maxEgressRequestsRaw = typeof obj.maxEgressRequests === "number" && Number.isFinite(obj.maxEgressRequests) ? obj.maxEgressRequests : null;
  const maxEgressRequests = maxEgressRequestsRaw === null ? 50 : Math.max(0, Math.min(1000, Math.round(maxEgressRequestsRaw)));
  return { timeoutMs, maxConcurrency, memoryMb, cpuMs, maxOutputBytes, maxEgressRequests };
}

export function normalizeNetworkPolicy(v: unknown): NetworkPolicy {
  const obj = isPlainObject(v) ? v : {};
  const allowedDomains = Array.isArray(obj.allowedDomains)
    ? obj.allowedDomains
        .filter((x) => typeof x === "string" && x.trim())
        .map((x: string) => x.trim().toLowerCase())
        .filter((x: string) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"))
    : [];
  const rulesRaw = Array.isArray((obj as any).rules) ? (obj as any).rules : [];
  const rules = rulesRaw
    .filter((x: any) => x && typeof x === "object" && !Array.isArray(x))
    .map((x: any) => {
      const host0 = typeof x.host === "string" ? x.host.trim().toLowerCase() : "";
      const host = host0 && !host0.includes("://") && !host0.includes("/") && !host0.includes(":") ? host0 : "";
      if (!host) return null;
      const pathPrefix0 = typeof x.pathPrefix === "string" ? x.pathPrefix.trim() : "";
      const pathPrefix = pathPrefix0 ? (pathPrefix0.startsWith("/") ? pathPrefix0 : `/${pathPrefix0}`) : undefined;
      const methods0 = Array.isArray(x.methods) ? x.methods.filter((m: any) => typeof m === "string" && m.trim()) : undefined;
      const methods = methods0?.length ? methods0.map((m: string) => m.trim().toUpperCase()) : undefined;
      return { host, pathPrefix, methods };
    })
    .filter(Boolean) as NetworkPolicyRule[];
  return { allowedDomains, rules };
}

export function isAllowedHost(allowedDomains: string[], host: string) {
  const h = host.toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === h);
}

export function isAllowedEgress(params: { policy: NetworkPolicy; url: string; method: string }): EgressCheck {
  const method = params.method.toUpperCase();
  let host = "";
  let pathName = "";
  let protocol = "";
  try {
    const u = new URL(params.url);
    protocol = u.protocol;
    host = u.hostname.toLowerCase();
    pathName = u.pathname || "/";
  } catch {
    return { allowed: false, host: "", method, reason: "policy_violation:egress_invalid_url" };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { allowed: false, host, method, reason: `policy_violation:egress_invalid_protocol:${protocol.replace(":", "")}` };
  }
  const allowedByDomain = isAllowedHost(params.policy.allowedDomains, host);
  if (allowedByDomain) return { allowed: true, host, method, reason: null, match: { kind: "allowedDomain" } };
  const rules = params.policy.rules ?? [];
  for (const r of rules) {
    if (String(r.host).toLowerCase() !== host.toLowerCase()) continue;
    if (r.pathPrefix && !pathName.startsWith(r.pathPrefix)) continue;
    if (r.methods && r.methods.length && !r.methods.includes(method)) continue;
    return { allowed: true, host, method, reason: null, match: { kind: "rule", rulePathPrefix: r.pathPrefix, ruleMethods: r.methods } };
  }
  return { allowed: false, host, method, reason: `policy_violation:egress_denied:${host}` };
}

export async function runtimeFetch(params: {
  url: string;
  method?: string;
  networkPolicy: NetworkPolicy;
  signal: AbortSignal;
  egress: EgressEvent[];
  maxEgressRequests: number;
}) {
  if (params.maxEgressRequests >= 0 && params.egress.length >= params.maxEgressRequests) {
    throw new Error("resource_exhausted:max_egress_requests");
  }
  const method = (params.method ?? "GET").toUpperCase();
  const check = isAllowedEgress({ policy: params.networkPolicy, url: params.url, method });
  if (!check.allowed) {
    params.egress.push({ host: check.host, method: check.method, allowed: false, errorCategory: "policy_violation" });
    throw new Error(check.reason ?? "policy_violation:egress_denied");
  }

  const res = await fetch(params.url, { method, signal: params.signal });
  params.egress.push({ host: check.host, method: check.method, allowed: true, policyMatch: check.match, status: res.status });
  return res;
}

export async function withConcurrency<T>(key: string, maxConcurrency: number, fn: () => Promise<T>) {
  const current = concurrencyCounters.get(key) ?? 0;
  if (current >= maxConcurrency) throw new Error("resource_exhausted:max_concurrency");
  concurrencyCounters.set(key, current + 1);
  try {
    return await fn();
  } finally {
    const after = (concurrencyCounters.get(key) ?? 1) - 1;
    if (after <= 0) concurrencyCounters.delete(key);
    else concurrencyCounters.set(key, after);
  }
}

export async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(t);
  }
}
