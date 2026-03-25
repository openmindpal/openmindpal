export type DlpHitType = "token" | "email" | "phone";
export type DlpMode = "audit_only" | "deny";
export type DlpPolicyVersion = "v1";

export type DlpPolicy = {
  version: DlpPolicyVersion;
  mode: DlpMode;
  denyTargets: Set<string>;
  denyHitTypes: Set<DlpHitType>;
};

export type DlpSummary = {
  hitCounts: Record<DlpHitType, number>;
  redacted: boolean;
  disposition?: "redact" | "deny";
  mode?: DlpMode;
  policyVersion?: DlpPolicyVersion;
};

const rules: Array<{ type: DlpHitType; re: RegExp }> = [
  { type: "token", re: /\bBearer\s+[A-Za-z0-9\-_.=]{10,}\b/gi },
  { type: "token", re: /\bsk[-_][A-Za-z0-9_]{10,}\b/g },
  { type: "token", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "token", re: /\bAIza[0-9A-Za-z\-_]{20,}\b/g },
  { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "phone", re: /\b\+\d{10,15}\b/g },
  { type: "phone", re: /\b1\d{10}\b/g },
];

const DEFAULT_DLP_DENY_TARGETS = "model:invoke,tool:execute";
const DEFAULT_DLP_DENY_HIT_TYPES = "token";

function normalizeDlpMode(value: unknown): DlpMode {
  return value === "deny" ? "deny" : "audit_only";
}

function normalizeStringSet(value: unknown, fallbackCsv: string) {
  if (value instanceof Set) return new Set(Array.from(value).map((x) => String(x).trim()).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map((x) => String(x).trim()).filter(Boolean));
  const raw = String(value ?? fallbackCsv);
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function normalizeDlpHitTypeSet(value: unknown, fallbackCsv: string) {
  const out = new Set<DlpHitType>();
  const src = normalizeStringSet(value, fallbackCsv);
  for (const item of src) {
    if (item === "token" || item === "email" || item === "phone") out.add(item);
  }
  if (!out.size) out.add("token");
  return out;
}

export function resolveDlpPolicy(input?: { version?: unknown; mode?: unknown; denyTargets?: unknown; denyHitTypes?: unknown }): DlpPolicy {
  return {
    version: input?.version === "v1" ? "v1" : "v1",
    mode: normalizeDlpMode(input?.mode),
    denyTargets: normalizeStringSet(input?.denyTargets, DEFAULT_DLP_DENY_TARGETS),
    denyHitTypes: normalizeDlpHitTypeSet(input?.denyHitTypes, DEFAULT_DLP_DENY_HIT_TYPES),
  };
}

export function resolveDlpPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): DlpPolicy {
  return resolveDlpPolicy({
    version: "v1",
    mode: env.DLP_MODE,
    denyTargets: env.DLP_DENY_TARGETS,
    denyHitTypes: env.DLP_DENY_HIT_TYPES,
  });
}

export function shouldDenyDlpForTarget(params: { summary: DlpSummary; target: string; policy: DlpPolicy }) {
  if (params.policy.mode !== "deny") return false;
  if (!params.policy.denyTargets.has(params.target)) return false;
  for (const type of params.policy.denyHitTypes) {
    if ((params.summary.hitCounts[type] ?? 0) > 0) return true;
  }
  return false;
}

export function redactString(input: string) {
  let redacted = input;
  const hitCounts: Record<DlpHitType, number> = { token: 0, email: 0, phone: 0 };
  let changed = false;

  for (const r of rules) {
    const re = new RegExp(r.re.source, r.re.flags);
    const matches = redacted.match(re);
    if (matches?.length) {
      hitCounts[r.type] += matches.length;
      changed = true;
      redacted = redacted.replace(re, "***REDACTED***");
    }
  }

  return { value: redacted, summary: { hitCounts, redacted: changed } satisfies DlpSummary };
}

function isPlainObject(v: unknown) {
  if (!v || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

export function redactValue(input: unknown, opts?: { maxDepth?: number; maxStringLen?: number }) {
  const maxDepth = opts?.maxDepth ?? 8;
  const maxStringLen = opts?.maxStringLen ?? 20_000;

  const hitCounts: Record<DlpHitType, number> = { token: 0, email: 0, phone: 0 };
  let redacted = false;

  function merge(s: DlpSummary) {
    hitCounts.token += s.hitCounts.token;
    hitCounts.email += s.hitCounts.email;
    hitCounts.phone += s.hitCounts.phone;
    redacted = redacted || s.redacted;
  }

  function walk(v: unknown, depth: number): unknown {
    if (typeof v === "string") {
      const clipped = v.length > maxStringLen ? v.slice(0, maxStringLen) : v;
      const r = redactString(clipped);
      merge(r.summary);
      return r.value;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
    if (depth >= maxDepth) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (isPlainObject(v)) {
      const out: any = {};
      for (const [k, vv] of Object.entries(v as any)) out[k] = walk(vv, depth + 1);
      return out;
    }
    return v;
  }

  const value = walk(input, 0);
  return { value, summary: { hitCounts, redacted } satisfies DlpSummary };
}

export function attachDlpSummary(value: unknown, summary: DlpSummary) {
  if (!summary.redacted) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as any), dlpSummary: summary };
  return { value, dlpSummary: summary };
}
