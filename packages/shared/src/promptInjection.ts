export type PromptInjectionHitSeverity = "low" | "medium" | "high";
export type PromptInjectionMode = "audit_only" | "deny";
export type PromptInjectionPolicyVersion = "v1";

export type PromptInjectionHit = {
  ruleId: string;
  severity: PromptInjectionHitSeverity;
};

export type PromptInjectionScanResult = {
  hits: PromptInjectionHit[];
  score: number;
  maxSeverity: PromptInjectionHitSeverity | "none";
};

export type PromptInjectionPolicy = {
  version: PromptInjectionPolicyVersion;
  mode: PromptInjectionMode;
  denyTargets: Set<string>;
  denyScore: number;
};

const DEFAULT_PI_DENY_TARGETS = "tool:execute,orchestrator:execute";
const DEFAULT_PI_DENY_SCORE = 6;

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function addHit(hits: PromptInjectionHit[], hit: PromptInjectionHit) {
  if (!hits.some((h) => h.ruleId === hit.ruleId)) hits.push(hit);
}

function severityScore(sev: PromptInjectionHitSeverity) {
  return sev === "high" ? 5 : sev === "medium" ? 2 : 1;
}

function maxSeverityOf(hits: PromptInjectionHit[]): PromptInjectionScanResult["maxSeverity"] {
  if (!hits.length) return "none";
  if (hits.some((h) => h.severity === "high")) return "high";
  if (hits.some((h) => h.severity === "medium")) return "medium";
  return "low";
}

function normalizePromptInjectionMode(value: unknown): PromptInjectionMode {
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

export function resolvePromptInjectionPolicy(input?: {
  version?: unknown;
  mode?: unknown;
  denyTargets?: unknown;
  denyScore?: unknown;
}): PromptInjectionPolicy {
  const score = Number(input?.denyScore);
  return {
    version: input?.version === "v1" ? "v1" : "v1",
    mode: normalizePromptInjectionMode(input?.mode),
    denyTargets: normalizeStringSet(input?.denyTargets, DEFAULT_PI_DENY_TARGETS),
    denyScore: Number.isFinite(score) && score > 0 ? score : DEFAULT_PI_DENY_SCORE,
  };
}

export function resolvePromptInjectionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PromptInjectionPolicy {
  return resolvePromptInjectionPolicy({
    version: "v1",
    mode: env.SAFETY_PI_MODE,
    denyTargets: env.SAFETY_PI_DENY_TARGETS,
    denyScore: env.SAFETY_PI_DENY_SCORE,
  });
}

export function detectPromptInjection(text: string): PromptInjectionScanResult {
  const hits: PromptInjectionHit[] = [];
  const t = normalizeText(text);
  if (!t) return { hits, score: 0, maxSeverity: "none" };

  if (/(ignore|disregard|forget)\s+(all\s+)?(previous|above)\s+(instructions|messages)/.test(t)) addHit(hits, { ruleId: "ignore_previous", severity: "high" });
  if (/(ignore|disregard|forget).{0,80}(system|developer)\s+(message|prompt|instructions)/.test(t)) addHit(hits, { ruleId: "ignore_system", severity: "high" });
  if (/(reveal|show|print|leak).{0,80}(system\s+prompt|developer\s+message|hidden\s+prompt)/.test(t))
    addHit(hits, { ruleId: "reveal_prompt", severity: "high" });
  if (/(api\s*key|secret|token|password|private\s+key).{0,80}(reveal|show|print|leak|dump|export)/.test(t))
    addHit(hits, { ruleId: "exfiltrate_secrets", severity: "high" });
  if (/(bypass|disable).{0,80}(policy|safety|guard|restriction|rbac|auth|authorization)/.test(t))
    addHit(hits, { ruleId: "bypass_safety", severity: "high" });

  if (/(run|execute|shell|terminal|powershell|bash|cmd).{0,80}(curl|wget|http|https)/.test(t)) addHit(hits, { ruleId: "command_network", severity: "medium" });
  if (/(delete|drop|truncate).{0,80}(database|table|records|files)/.test(t)) addHit(hits, { ruleId: "destructive_action", severity: "medium" });
  if (/(transfer|wire|send).{0,40}(money|funds|payment|crypto|bank)/.test(t)) addHit(hits, { ruleId: "financial_action", severity: "medium" });

  if (/^system:|^developer:|^assistant:/.test(t)) addHit(hits, { ruleId: "role_prefix", severity: "low" });
  if (/(do not tell|don't tell).{0,40}(user|anyone)|confidential/.test(t)) addHit(hits, { ruleId: "secrecy", severity: "low" });

  const score = hits.reduce((acc, h) => acc + severityScore(h.severity), 0);
  return { hits, score, maxSeverity: maxSeverityOf(hits) };
}

export function shouldDenyPromptInjection(scan: PromptInjectionScanResult, policy?: PromptInjectionPolicy) {
  const resolved = policy ?? resolvePromptInjectionPolicy();
  if (resolved.mode !== "deny") return false;
  if (scan.maxSeverity === "high") return true;
  return scan.score >= resolved.denyScore;
}
