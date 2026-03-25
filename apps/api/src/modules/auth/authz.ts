import type { Pool } from "pg";
import type { PolicyDecision } from "@openslin/shared";
import { validatePolicyExpr } from "@openslin/shared";
import { createPolicySnapshot } from "./policySnapshotRepo";
import { getPolicyCacheEpoch } from "./policyCacheEpochRepo";
import { evaluateAbacPolicy, parseAbacConditions, type AbacContext, type AbacResult } from "./abacEngine";

export type ResourceAction = {
  resourceType: string;
  action: string;
};

/* --- ABAC condition types --- architecture-05 section 7 --- */

export type AbacCondition =
  | { kind: "time_window"; afterHour: number; beforeHour: number; timezone?: string }
  | { kind: "day_of_week"; days: number[] }
  | { kind: "ip_range"; cidrs: string[] }
  | { kind: "geo_country"; countries: string[] };

function evaluateTimeWindow(cond: Extract<AbacCondition, { kind: "time_window" }>, now: Date): boolean {
  const tz = cond.timezone ?? "UTC";
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now);
    hour = parseInt(parts, 10);
  } catch {
    hour = now.getUTCHours();
  }
  if (cond.afterHour <= cond.beforeHour) {
    return hour >= cond.afterHour && hour < cond.beforeHour;
  }
  return hour >= cond.afterHour || hour < cond.beforeHour;
}

function evaluateDayOfWeek(cond: Extract<AbacCondition, { kind: "day_of_week" }>, now: Date): boolean {
  return cond.days.includes(now.getUTCDay());
}

function ipToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function evaluateIpRange(cond: Extract<AbacCondition, { kind: "ip_range" }>, clientIp: string | null): boolean {
  if (!clientIp) return false;
  const ipLong = ipToLong(clientIp);
  if (ipLong < 0) return false;
  for (const cidr of cond.cidrs) {
    const [base, bits] = cidr.split("/");
    const baseLong = ipToLong(base);
    if (baseLong < 0) continue;
    const mask = bits ? (~0 << (32 - parseInt(bits, 10))) >>> 0 : 0xffffffff;
    if ((ipLong & mask) === (baseLong & mask)) return true;
  }
  return false;
}

function evaluateGeoCountry(cond: Extract<AbacCondition, { kind: "geo_country" }>, country: string | null): boolean {
  if (!country) return false;
  return cond.countries.map((c) => c.toUpperCase()).includes(country.toUpperCase());
}

export function evaluateAbacConditions(conditions: AbacCondition[], context: { now?: Date; clientIp?: string | null; country?: string | null }): { allowed: boolean; failedCondition?: string } {
  const now = context.now ?? new Date();
  for (const cond of conditions) {
    switch (cond.kind) {
      case "time_window":
        if (!evaluateTimeWindow(cond, now)) return { allowed: false, failedCondition: "time_window" };
        break;
      case "day_of_week":
        if (!evaluateDayOfWeek(cond, now)) return { allowed: false, failedCondition: "day_of_week" };
        break;
      case "ip_range":
        if (!evaluateIpRange(cond, context.clientIp ?? null)) return { allowed: false, failedCondition: "ip_range" };
        break;
      case "geo_country":
        if (!evaluateGeoCountry(cond, context.country ?? null)) return { allowed: false, failedCondition: "geo_country" };
        break;
    }
  }
  return { allowed: true };
}

type PermissionRow = {
  role_id: string;
  resource_type: string;
  action: string;
  field_rules_read?: any;
  field_rules_write?: any;
  row_filters_read?: any;
  row_filters_write?: any;
  field_rules_condition?: any;
};

type CachedAuthz = {
  roleIds: string[];
  perms: PermissionRow[];
  expiresAtMs: number;
};

const authzCache = new Map<string, CachedAuthz>();

function isFieldRulesTrivial(fieldRules: any) {
  const readAllowAll = Boolean(fieldRules?.read?.allow?.includes?.("*"));
  const writeAllowAll = Boolean(fieldRules?.write?.allow?.includes?.("*"));
  const readDenyEmpty = !fieldRules?.read?.deny || fieldRules.read.deny.length === 0;
  const writeDenyEmpty = !fieldRules?.write?.deny || fieldRules.write.deny.length === 0;
  return readAllowAll && writeAllowAll && readDenyEmpty && writeDenyEmpty;
}

function buildExplainV1(params: {
  decision: "allow" | "deny";
  reason: string | null;
  matchedRules: any;
  rowFilters: any;
  fieldRules: any;
  policyRef: { name: string; version: number };
  policyCacheEpoch: any;
}) {
  const reasons: string[] = [];
  const r = params.reason ?? "";
  if (r === "no_role_binding" || r === "permission_denied") reasons.push("missing_permission");
  if (r === "unsupported_policy_expr") reasons.push("unsupported_policy_expr");
  if (params.rowFilters) reasons.push("row_filter_applied");
  if (params.fieldRules && !isFieldRulesTrivial(params.fieldRules)) reasons.push("field_rule_applied");

  const perms = Array.isArray(params.matchedRules?.permissions) ? params.matchedRules.permissions : [];
  const matchedRules = perms
    .map((p: any) => ({
      kind: "role_permission",
      roleId: String(p?.role_id ?? p?.roleId ?? ""),
      resourceType: String(p?.resource_type ?? p?.resourceType ?? ""),
      action: String(p?.action ?? ""),
    }))
    .filter((x: any) => x.roleId && x.resourceType && x.action);

  return {
    version: 1,
    decision: params.decision,
    reasons,
    policyRef: params.policyRef,
    policyCacheEpoch: params.policyCacheEpoch,
    matchedRules,
  };
}

function cacheGet<T>(m: Map<string, any>, key: string): T | null {
  const v = m.get(key);
  if (!v) return null;
  if (typeof v.expiresAtMs === "number" && v.expiresAtMs < Date.now()) {
    m.delete(key);
    return null;
  }
  return v as T;
}

function cacheSet(m: Map<string, any>, key: string, value: any, maxSize: number) {
  m.set(key, value);
  if (m.size <= maxSize) return;
  const it = m.keys().next();
  if (!it.done) m.delete(it.value);
}

function normalizeRule(v: any) {
  const allow = Array.isArray(v?.allow) ? v.allow.filter((x: any) => typeof x === "string") : undefined;
  const deny = Array.isArray(v?.deny) ? v.deny.filter((x: any) => typeof x === "string") : undefined;
  return { allow, deny };
}

function mergeAllow(existing: string[] | undefined, incoming: string[] | undefined) {
  if (!incoming || incoming.length === 0) return existing;
  if (incoming.includes("*")) return ["*"];
  if (existing && existing.includes("*")) return existing;
  const set = new Set<string>(existing ?? []);
  for (const k of incoming) set.add(k);
  return Array.from(set);
}

function mergeDeny(existing: string[] | undefined, incoming: string[] | undefined) {
  if (!incoming || incoming.length === 0) return existing;
  const set = new Set<string>(existing ?? []);
  for (const k of incoming) set.add(k);
  return Array.from(set);
}

function mergeFieldRules(perms: PermissionRow[]) {
  let readAllow: string[] | undefined;
  let readDeny: string[] | undefined;
  let writeAllow: string[] | undefined;
  let writeDeny: string[] | undefined;
  const conditionalRules: any[] = [];

  for (const p of perms) {
    // Conditional field rules (attached to ABAC condition)
    if (p.field_rules_condition) {
      const r = normalizeRule(p.field_rules_read);
      const w = normalizeRule(p.field_rules_write);
      const fr: any = {};
      if (r.allow || r.deny) fr.read = { allow: r.allow, deny: r.deny };
      if (w.allow || w.deny) fr.write = { allow: w.allow, deny: w.deny };
      if (Object.keys(fr).length) {
        conditionalRules.push({ condition: p.field_rules_condition, fieldRules: fr });
      }
      continue;
    }
    const r = normalizeRule(p.field_rules_read);
    const w = normalizeRule(p.field_rules_write);
    readAllow = mergeAllow(readAllow, r.allow);
    readDeny = mergeDeny(readDeny, r.deny);
    writeAllow = mergeAllow(writeAllow, w.allow);
    writeDeny = mergeDeny(writeDeny, w.deny);
  }

  // Deny-wins: if a field is in both allow and deny, deny takes precedence
  if (readAllow && readDeny) {
    readAllow = readAllow.filter((f) => f === "*" || !readDeny!.includes(f));
    if (readAllow.length === 0) readAllow = undefined;
  }
  if (writeAllow && writeDeny) {
    writeAllow = writeAllow.filter((f) => f === "*" || !writeDeny!.includes(f));
    if (writeAllow.length === 0) writeAllow = undefined;
  }

  const out: any = {};
  if (readAllow || (readDeny && readDeny.length > 0)) out.read = { allow: readAllow, deny: readDeny };
  if (writeAllow || (writeDeny && writeDeny.length > 0)) out.write = { allow: writeAllow, deny: writeDeny };
  const result = Object.keys(out).length ? out : undefined;
  return { fieldRules: result, conditionalFieldRules: conditionalRules.length > 0 ? conditionalRules : undefined };
}

function normalizeOneRowFilter(rf: any): any {
  if (!rf || typeof rf !== "object" || Array.isArray(rf)) throw new Error("unsupported_row_filters");
  const kind = String((rf as any).kind ?? "");
  if (kind === "owner_only") return { kind: "owner_only" };
  if (kind === "expr") {
    const expr = (rf as any).expr;
    const v = validatePolicyExpr(expr);
    if (!v.ok) throw new Error("unsupported_policy_expr");
    return { kind: "expr", expr: v.expr };
  }
  if (kind === "payload_field_eq_subject") {
    const field = String((rf as any).field ?? "");
    if (!field) throw new Error("unsupported_row_filters");
    return { kind: "payload_field_eq_subject", field };
  }
  if (kind === "payload_field_eq_literal") {
    const field = String((rf as any).field ?? "");
    const value = (rf as any).value;
    const t = typeof value;
    if (!field) throw new Error("unsupported_row_filters");
    if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("unsupported_row_filters");
    return { kind: "payload_field_eq_literal", field, value };
  }
  if (kind === "space_member") {
    const roles = (rf as any).roles;
    const out: any = { kind: "space_member" };
    if (Array.isArray(roles) && roles.length > 0) out.roles = roles.map(String).filter(Boolean);
    return out;
  }
  if (kind === "org_hierarchy") {
    const orgField = String((rf as any).orgField ?? "orgUnitId");
    const includeDescendants = Boolean((rf as any).includeDescendants ?? true);
    return { kind: "org_hierarchy", orgField, includeDescendants };
  }
  if (kind === "or" && Array.isArray((rf as any).rules)) {
    const children = (rf as any).rules.map((child: any) => normalizeOneRowFilter(child));
    return { kind: "or", rules: children };
  }
  if (kind === "and" && Array.isArray((rf as any).rules)) {
    const children = (rf as any).rules.map((child: any) => normalizeOneRowFilter(child));
    return { kind: "and", rules: children };
  }
  if (kind === "not" && (rf as any).rule) {
    const child = normalizeOneRowFilter((rf as any).rule);
    return { kind: "not", rule: child };
  }
  throw new Error("unsupported_row_filters");
}

function resolveRowFilterMergeMode(resourceType: string) {
  const raw = String(process.env.AUTHZ_ROW_FILTER_MERGE_MODE ?? "").trim().toLowerCase();
  if (raw === "intersection" || raw === "and") return "intersection";
  if (raw === "union" || raw === "or") return "union";

  const conf = String(process.env.AUTHZ_ROW_FILTER_CONSERVATIVE_RESOURCE_TYPES ?? "").trim();
  const conservative = new Set(conf.split(",").map((x) => x.trim()).filter(Boolean));
  if (conservative.size === 0) {
    for (const t of ["secret", "secrets", "audit", "policy_snapshot", "policy-snapshot", "connector_secret", "keyring"]) conservative.add(t);
  }
  return conservative.has(resourceType) ? "intersection" : "union";
}

function mergeRowFilters(perms: PermissionRow[], mode: "read" | "write", resourceType: string) {
  const mergeMode = resolveRowFilterMergeMode(resourceType);
  let sawNull = false;
  const rules: any[] = [];
  for (const p of perms) {
    const rf = mode === "write" ? p.row_filters_write : p.row_filters_read;
    if (rf === null || rf === undefined) {
      sawNull = true;
      continue;
    }
    rules.push(normalizeOneRowFilter(rf));
  }
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  if (mergeMode === "intersection") return { kind: "and", rules };
  if (sawNull) return undefined;
  return { kind: "or", rules };
}

export async function authorize(params: {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId?: string;
  resourceType: string;
  action: string;
  abacCtx?: AbacContext;
}): Promise<PolicyDecision> {
  const tenantEpoch = await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId });
  const spaceEpoch = params.spaceId ? await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: params.spaceId }) : 0;
  const cacheKey = `${params.tenantId}|${params.spaceId ?? ""}|${params.subjectId}|${params.resourceType}|${params.action}|${tenantEpoch}|${spaceEpoch}`;
  const cached = cacheGet<CachedAuthz>(authzCache, cacheKey);
  const policyRef = { name: "default", version: 1 };
  const policyCacheEpoch = { tenant: tenantEpoch, space: spaceEpoch };

  let roleIds: string[];
  let perms: PermissionRow[];
  if (cached) {
    roleIds = cached.roleIds;
    perms = cached.perms;
  } else {
    const rolesRes = await params.pool.query(
      `
        SELECT DISTINCT rb.role_id
        FROM role_bindings rb
        JOIN roles r ON r.id = rb.role_id
        WHERE rb.subject_id = $1
          AND r.tenant_id = $2
          AND (
            (rb.scope_type = 'tenant' AND rb.scope_id = $2)
            OR ($3::text IS NOT NULL AND rb.scope_type = 'space' AND rb.scope_id = $3)
          )
      `,
      [params.subjectId, params.tenantId, params.spaceId ?? null],
    );
    roleIds = rolesRes.rows.map((r) => r.role_id as string);
    if (roleIds.length === 0) {
      perms = [];
    } else {
      const permsRes = await params.pool.query<PermissionRow>(
        `
          SELECT rp.role_id, p.resource_type, p.action, rp.field_rules_read, rp.field_rules_write, rp.row_filters_read, rp.row_filters_write, rp.field_rules_condition
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ANY($1::text[])
        `,
        [roleIds],
      );
      perms = permsRes.rows;
    }
    cacheSet(authzCache, cacheKey, { roleIds, perms, expiresAtMs: Date.now() + 30000 } satisfies CachedAuthz, 50000);
  }

  if (roleIds.length === 0) {
    const explainV1 = buildExplainV1({ decision: "deny", reason: "no_role_binding", matchedRules: { roleIds: [], permissions: [] }, rowFilters: null, fieldRules: null, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason: "no_role_binding",
      matchedRules: { roleIds: [], permissions: [] },
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return { decision: "deny", reason: "no_role_binding", snapshotRef: `policy_snapshot:${snap.snapshotId}`, policyRef, policyCacheEpoch, explainV1 };
  }

  const allowed = perms.some((p) => {
    const resourceOk = p.resource_type === "*" || p.resource_type === params.resourceType;
    const actionOk = p.action === "*" || p.action === params.action;
    return resourceOk && actionOk;
  });
  const matchedPerms = perms.filter((p) => {
    const resourceOk = p.resource_type === "*" || p.resource_type === params.resourceType;
    const actionOk = p.action === "*" || p.action === params.action;
    return resourceOk && actionOk;
  });
  const { fieldRules, conditionalFieldRules } = mergeFieldRules(matchedPerms);
  const mode = ["create", "update", "delete"].includes(params.action) ? ("write" as const) : ("read" as const);
  let rowFilters: any | undefined;
  try {
    rowFilters = mergeRowFilters(matchedPerms, mode, params.resourceType);
  } catch (e: any) {
    const reason = String(e?.message ?? "") === "unsupported_policy_expr" ? "unsupported_policy_expr" : "unsupported_row_filters";
    const explainV1 = buildExplainV1({ decision: "deny", reason, matchedRules: { roleIds, permissions: perms }, rowFilters: null, fieldRules: fieldRules as any, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason,
      matchedRules: { roleIds, permissions: perms },
      fieldRules: fieldRules as any,
      rowFilters: null,
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return {
      decision: "deny",
      reason,
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      conditionalFieldRules,
      rowFilters: null,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  if (!allowed) {
    const explainV1 = buildExplainV1({ decision: "deny", reason: "permission_denied", matchedRules: { roleIds, permissions: perms }, rowFilters, fieldRules: fieldRules as any, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason: "permission_denied",
      matchedRules: { roleIds, permissions: perms },
      fieldRules: fieldRules as any,
      rowFilters,
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return {
      decision: "deny",
      reason: "permission_denied",
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      conditionalFieldRules,
      rowFilters,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  const effectiveFieldRules = fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } };
  let lastAbacResult: AbacResult | undefined;

  /* ─── ABAC condition evaluation (§7) ─── */
  if (params.abacCtx) {
    try {
      const abacRulesRes = await params.pool.query(
        `SELECT conditions FROM abac_policies
         WHERE tenant_id = $1 AND resource_type = $2 AND action = $3 AND enabled = true
         ORDER BY priority ASC LIMIT 10`,
        [params.tenantId, params.resourceType, params.action],
      );
      for (const row of abacRulesRes.rows) {
        const conditions = parseAbacConditions((row as any).conditions);
        if (conditions.length === 0) continue;
        const abacResult = evaluateAbacPolicy({ conditions, ctx: params.abacCtx });
        lastAbacResult = abacResult;
        if (!abacResult.allowed) {
          const reason = `abac:${abacResult.reason}`;
          const explainV1 = buildExplainV1({
            decision: "deny",
            reason,
            matchedRules: { roleIds, permissions: perms },
            rowFilters,
            fieldRules: effectiveFieldRules,
            policyRef,
            policyCacheEpoch,
          });
          const snap = await createPolicySnapshot({
            pool: params.pool,
            tenantId: params.tenantId,
            subjectId: params.subjectId,
            spaceId: params.spaceId ?? null,
            resourceType: params.resourceType,
            action: params.action,
            decision: "deny",
            reason,
            matchedRules: { roleIds, permissions: perms },
            rowFilters,
            fieldRules: effectiveFieldRules,
            policyRef,
            policyCacheEpoch,
            explainV1: { ...explainV1, abac: abacResult },
          });
          return {
            decision: "deny",
            reason,
            matchedRules: { roleIds, permissions: perms },
            fieldRules: effectiveFieldRules,
            conditionalFieldRules,
            rowFilters,
            snapshotRef: `policy_snapshot:${snap.snapshotId}`,
            policyRef,
            policyCacheEpoch,
            explainV1: { ...explainV1, abac: abacResult },
            abacResult,
          };
        }
      }
    } catch {
      /* ABAC table may not exist yet – degrade gracefully */
    }
  }

  const baseExplainV1 = buildExplainV1({
    decision: "allow",
    reason: "permission_allowed",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: effectiveFieldRules,
    policyRef,
    policyCacheEpoch,
  });
  const explainV1 = lastAbacResult ? { ...baseExplainV1, abac: lastAbacResult } : baseExplainV1;
  const snap = await createPolicySnapshot({
    pool: params.pool,
    tenantId: params.tenantId,
    subjectId: params.subjectId,
    spaceId: params.spaceId ?? null,
    resourceType: params.resourceType,
    action: params.action,
    decision: "allow",
    reason: "permission_allowed",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: effectiveFieldRules,
    policyRef,
    policyCacheEpoch,
    explainV1,
  });
  const snapshotRef = `policy_snapshot:${snap.snapshotId}`;

  return {
    decision: "allow",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: effectiveFieldRules,
    conditionalFieldRules,
    snapshotRef,
    policyRef,
    policyCacheEpoch,
    explainV1,
  };
}
