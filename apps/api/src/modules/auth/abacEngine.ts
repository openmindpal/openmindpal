/**
 * ABAC Runtime Engine — 架构-05 §7
 * Evaluates attribute-based conditions: time windows, geo regions, IP ranges, custom attributes.
 */

export type AbacCondition =
  | { kind: "time_window"; after?: string; before?: string; timezone?: string; daysOfWeek?: number[] }
  | { kind: "geo_region"; allowed?: string[]; denied?: string[] }
  | { kind: "ip_range"; cidrs: string[] }
  | { kind: "attribute_eq"; attribute: string; value: unknown }
  | { kind: "attribute_in"; attribute: string; values: unknown[] }
  | { kind: "risk_level"; allowed: string[] }       // e.g. ["low", "medium"]
  | { kind: "data_label"; required?: string[]; denied?: string[] } // tag-based data classification
  | { kind: "device_type"; allowed: string[] }       // e.g. ["desktop", "mobile", "tablet"]
  | { kind: "and"; conditions: AbacCondition[] }
  | { kind: "or"; conditions: AbacCondition[] }
  | { kind: "not"; condition: AbacCondition };

export type AbacContext = {
  now?: Date;
  clientIp?: string;
  geoRegion?: string;
  riskLevel?: string;
  dataLabels?: string[];
  deviceType?: string;
  attributes?: Record<string, unknown>;
};

export type AbacResult = {
  allowed: boolean;
  reason: string;
  evaluatedConditions: number;
  failedCondition?: string;
};

/* ─── Time window evaluation ─── */

function evaluateTimeWindow(cond: Extract<AbacCondition, { kind: "time_window" }>, ctx: AbacContext): boolean {
  const now = ctx.now ?? new Date();
  const hours = now.getUTCHours();
  const minutes = now.getUTCMinutes();
  const currentMinutes = hours * 60 + minutes;
  const dayOfWeek = now.getUTCDay(); // 0=Sun

  if (cond.daysOfWeek && cond.daysOfWeek.length > 0) {
    if (!cond.daysOfWeek.includes(dayOfWeek)) return false;
  }

  if (cond.after) {
    const [h, m] = cond.after.split(":").map(Number);
    if (currentMinutes < h * 60 + (m || 0)) return false;
  }

  if (cond.before) {
    const [h, m] = cond.before.split(":").map(Number);
    if (currentMinutes >= h * 60 + (m || 0)) return false;
  }

  return true;
}

/* ─── Geo region evaluation ─── */

function evaluateGeoRegion(cond: Extract<AbacCondition, { kind: "geo_region" }>, ctx: AbacContext): boolean {
  const region = (ctx.geoRegion ?? "").toUpperCase();
  if (!region) return true; // no geo info → pass

  if (cond.denied && cond.denied.length > 0) {
    if (cond.denied.map((r) => r.toUpperCase()).includes(region)) return false;
  }

  if (cond.allowed && cond.allowed.length > 0) {
    if (!cond.allowed.map((r) => r.toUpperCase()).includes(region)) return false;
  }

  return true;
}

/* ─── IP range evaluation (simple CIDR check) ─── */

function ipToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr ?? "32", 10);
  if (prefix < 0 || prefix > 32) return false;
  const ipLong = ipToLong(ip);
  const netLong = ipToLong(network);
  if (ipLong < 0 || netLong < 0) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipLong & mask) === (netLong & mask);
}

function evaluateIpRange(cond: Extract<AbacCondition, { kind: "ip_range" }>, ctx: AbacContext): boolean {
  const ip = ctx.clientIp ?? "";
  if (!ip || !cond.cidrs.length) return true;
  return cond.cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

/* ─── Attribute evaluation ─── */

function evaluateAttributeEq(cond: Extract<AbacCondition, { kind: "attribute_eq" }>, ctx: AbacContext): boolean {
  const val = ctx.attributes?.[cond.attribute];
  return val === cond.value;
}

function evaluateAttributeIn(cond: Extract<AbacCondition, { kind: "attribute_in" }>, ctx: AbacContext): boolean {
  const val = ctx.attributes?.[cond.attribute];
  return cond.values.includes(val);
}

/* ─── Risk level evaluation ─── */

function evaluateRiskLevel(cond: Extract<AbacCondition, { kind: "risk_level" }>, ctx: AbacContext): boolean {
  const level = (ctx.riskLevel ?? "").toLowerCase();
  if (!level) return true; // no risk info → pass
  return cond.allowed.map((r) => r.toLowerCase()).includes(level);
}

/* ─── Data label evaluation ─── */

function evaluateDataLabel(cond: Extract<AbacCondition, { kind: "data_label" }>, ctx: AbacContext): boolean {
  const labels = (ctx.dataLabels ?? []).map((l) => l.toLowerCase());
  if (cond.denied && cond.denied.length > 0) {
    for (const d of cond.denied) {
      if (labels.includes(d.toLowerCase())) return false;
    }
  }
  if (cond.required && cond.required.length > 0) {
    for (const r of cond.required) {
      if (!labels.includes(r.toLowerCase())) return false;
    }
  }
  return true;
}

/* ─── Device type evaluation ─── */

function evaluateDeviceType(cond: Extract<AbacCondition, { kind: "device_type" }>, ctx: AbacContext): boolean {
  const device = (ctx.deviceType ?? "").toLowerCase();
  if (!device) return true; // no device info → pass
  return cond.allowed.map((d) => d.toLowerCase()).includes(device);
}

/* ─── Recursive evaluator ─── */

export function evaluateAbacCondition(condition: AbacCondition, ctx: AbacContext): boolean {
  switch (condition.kind) {
    case "time_window":
      return evaluateTimeWindow(condition, ctx);
    case "geo_region":
      return evaluateGeoRegion(condition, ctx);
    case "ip_range":
      return evaluateIpRange(condition, ctx);
    case "attribute_eq":
      return evaluateAttributeEq(condition, ctx);
    case "attribute_in":
      return evaluateAttributeIn(condition, ctx);
    case "risk_level":
      return evaluateRiskLevel(condition, ctx);
    case "data_label":
      return evaluateDataLabel(condition, ctx);
    case "device_type":
      return evaluateDeviceType(condition, ctx);
    case "and":
      return condition.conditions.every((c) => evaluateAbacCondition(c, ctx));
    case "or":
      return condition.conditions.some((c) => evaluateAbacCondition(c, ctx));
    case "not":
      return !evaluateAbacCondition(condition.condition, ctx);
    default:
      return false;
  }
}

/* ─── Top-level evaluator with full result ─── */

export function evaluateAbacPolicy(params: {
  conditions: AbacCondition[];
  ctx: AbacContext;
  mode?: "all" | "any";
}): AbacResult {
  const { conditions, ctx, mode = "all" } = params;
  let evaluatedConditions = 0;

  for (const cond of conditions) {
    evaluatedConditions++;
    const result = evaluateAbacCondition(cond, ctx);
    if (mode === "all" && !result) {
      return {
        allowed: false,
        reason: `condition_failed:${cond.kind}`,
        evaluatedConditions,
        failedCondition: cond.kind,
      };
    }
    if (mode === "any" && result) {
      return { allowed: true, reason: "condition_matched", evaluatedConditions };
    }
  }

  if (mode === "any" && conditions.length > 0) {
    return { allowed: false, reason: "no_condition_matched", evaluatedConditions };
  }

  return { allowed: true, reason: "all_conditions_passed", evaluatedConditions };
}

/* ─── Parse conditions from JSONB policy ─── */

export function parseAbacConditions(raw: unknown): AbacCondition[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.filter((c) => c && typeof c === "object" && typeof c.kind === "string") as AbacCondition[];
}
