import type { PolicyDecision } from "@openslin/shared";

function allowAll(allow: string[] | undefined) {
  return Boolean(allow?.includes("*"));
}

export function applyWriteFieldRules(payload: Record<string, unknown>, decision: PolicyDecision) {
  const allow = decision.fieldRules?.write?.allow;
  const deny = decision.fieldRules?.write?.deny;
  if (allowAll(allow) && (!deny || deny.length === 0)) return payload;

  const forbidden: string[] = [];
  for (const k of Object.keys(payload)) {
    if (deny?.includes(k)) forbidden.push(k);
    else if (allow && allow.length > 0 && !allowAll(allow) && !allow.includes(k)) forbidden.push(k);
  }
  if (forbidden.length > 0) {
    const err: any = new Error("FIELD_WRITE_FORBIDDEN");
    err.fields = forbidden;
    throw err;
  }
  return payload;
}

export function applyReadFieldRules(payload: Record<string, unknown>, decision: PolicyDecision) {
  const allow = decision.fieldRules?.read?.allow;
  const deny = decision.fieldRules?.read?.deny;
  if (allowAll(allow) && (!deny || deny.length === 0)) return payload;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (deny?.includes(k)) continue;
    if (allow && allow.length > 0 && !allowAll(allow) && !allow.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
