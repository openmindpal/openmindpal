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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function normalizeNetworkPolicy(v: unknown): NetworkPolicy {
  const obj = isPlainObject(v) ? v : {};
  const allowedDomains = Array.isArray((obj as any).allowedDomains)
    ? ((obj as any).allowedDomains as any[])
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

function isAllowedHost(allowedDomains: string[], host: string) {
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

// ── Egress 审计日志持久化 ──────────────────────────────────────────
export type EgressAuditEntry = {
  timestamp: string;
  requestId: string;
  toolRef: string;
  tenantId: string;
  host: string;
  method: string;
  allowed: boolean;
  policyMatch?: EgressEvent["policyMatch"];
  status?: number;
  errorCategory?: string;
};

const egressAuditBuffer: EgressAuditEntry[] = [];
const EGRESS_AUDIT_FLUSH_SIZE = Number(process.env.EGRESS_AUDIT_FLUSH_SIZE ?? "50") || 50;
const EGRESS_AUDIT_FLUSH_INTERVAL_MS = Number(process.env.EGRESS_AUDIT_FLUSH_INTERVAL_MS ?? "5000") || 5000;
let egressFlushTimer: ReturnType<typeof setInterval> | null = null;
let egressAuditSink: ((entries: EgressAuditEntry[]) => Promise<void>) | null = null;

export function setEgressAuditSink(sink: (entries: EgressAuditEntry[]) => Promise<void>) {
  egressAuditSink = sink;
  if (!egressFlushTimer) {
    egressFlushTimer = setInterval(() => flushEgressAuditBuffer(), EGRESS_AUDIT_FLUSH_INTERVAL_MS);
    egressFlushTimer.unref();
  }
}

export function pushEgressAudit(ctx: { requestId: string; toolRef: string; tenantId: string }, events: EgressEvent[]) {
  const now = new Date().toISOString();
  for (const ev of events) {
    egressAuditBuffer.push({
      timestamp: now,
      requestId: ctx.requestId,
      toolRef: ctx.toolRef,
      tenantId: ctx.tenantId,
      host: ev.host,
      method: ev.method,
      allowed: ev.allowed,
      policyMatch: ev.policyMatch,
      status: ev.status,
      errorCategory: ev.errorCategory,
    });
  }
  if (egressAuditBuffer.length >= EGRESS_AUDIT_FLUSH_SIZE) {
    void flushEgressAuditBuffer();
  }
}

async function flushEgressAuditBuffer() {
  if (!egressAuditBuffer.length || !egressAuditSink) return;
  const batch = egressAuditBuffer.splice(0, EGRESS_AUDIT_FLUSH_SIZE);
  try {
    await egressAuditSink(batch);
  } catch {
    // 失败时将条目放回缓冲区头部以便重试
    egressAuditBuffer.unshift(...batch);
  }
}

