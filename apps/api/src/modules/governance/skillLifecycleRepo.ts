import type { Pool, PoolClient } from "pg";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillLifecycleStatus =
  | "draft"
  | "enabled_user_scope"
  | "enabled_space"
  | "enabled_tenant"
  | "disabled"
  | "revoked";

export type SkillScopeType = "user" | "space" | "tenant";

export type SkillLifecycleEventRow = {
  eventId: string;
  tenantId: string;
  skillName: string;
  skillVersion: string | null;
  fromStatus: string | null;
  toStatus: SkillLifecycleStatus;
  scopeType: SkillScopeType;
  scopeId: string;
  changedBy: string | null;
  approvalId: string | null;
  reason: string | null;
  createdAt: string;
};

type Q = Pool | PoolClient;

function toEvent(r: any): SkillLifecycleEventRow {
  return {
    eventId: r.event_id,
    tenantId: r.tenant_id,
    skillName: r.skill_name,
    skillVersion: r.skill_version ?? null,
    fromStatus: r.from_status ?? null,
    toStatus: r.to_status,
    scopeType: r.scope_type ?? "user",
    scopeId: r.scope_id,
    changedBy: r.changed_by ?? null,
    approvalId: r.approval_id ?? null,
    reason: r.reason ?? null,
    createdAt: r.created_at,
  };
}

// ─── Valid Transitions ──────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, SkillLifecycleStatus[]> = {
  "": ["draft"],
  draft: ["enabled_user_scope", "disabled", "revoked"],
  enabled_user_scope: ["enabled_space", "disabled", "revoked"],
  enabled_space: ["enabled_tenant", "disabled", "revoked"],
  enabled_tenant: ["disabled", "revoked"],
  disabled: ["enabled_user_scope", "enabled_space", "enabled_tenant", "revoked"],
};

export function isValidTransition(from: string | null, to: SkillLifecycleStatus): boolean {
  const fromKey = from ?? "";
  const allowed = VALID_TRANSITIONS[fromKey];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Determine what approval level is needed for a lifecycle transition
 */
export function getRequiredApprovalLevel(to: SkillLifecycleStatus): "none" | "admin" | "owner" {
  switch (to) {
    case "draft":
    case "disabled":
      return "none";
    case "enabled_user_scope":
      return "owner";
    case "enabled_space":
    case "enabled_tenant":
    case "revoked":
      return "admin";
    default:
      return "admin";
  }
}

// ─── Event Recording ────────────────────────────────────────────────────────

export async function recordLifecycleEvent(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  skillVersion?: string;
  fromStatus: string | null;
  toStatus: SkillLifecycleStatus;
  scopeType: SkillScopeType;
  scopeId: string;
  changedBy?: string;
  approvalId?: string;
  reason?: string;
}): Promise<SkillLifecycleEventRow> {
  if (!isValidTransition(params.fromStatus, params.toStatus)) {
    throw new Error(`skill_lifecycle:invalid_transition:${params.fromStatus ?? "null"}->${params.toStatus}`);
  }

  const res = await params.pool.query(
    `INSERT INTO skill_lifecycle_events (tenant_id, skill_name, skill_version, from_status, to_status, scope_type, scope_id, changed_by, approval_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      params.tenantId,
      params.skillName,
      params.skillVersion ?? null,
      params.fromStatus ?? null,
      params.toStatus,
      params.scopeType,
      params.scopeId,
      params.changedBy ?? null,
      params.approvalId ?? null,
      params.reason ?? null,
    ],
  );
  return toEvent(res.rows[0]);
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function getLatestSkillStatus(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  scopeType?: SkillScopeType;
  scopeId?: string;
}): Promise<SkillLifecycleEventRow | null> {
  const args: any[] = [params.tenantId, params.skillName];
  let where = "tenant_id=$1 AND skill_name=$2";
  if (params.scopeType) {
    args.push(params.scopeType);
    where += ` AND scope_type=$${args.length}`;
  }
  if (params.scopeId) {
    args.push(params.scopeId);
    where += ` AND scope_id=$${args.length}`;
  }
  const res = await params.pool.query(
    `SELECT * FROM skill_lifecycle_events WHERE ${where} ORDER BY created_at DESC LIMIT 1`,
    args,
  );
  if (!res.rowCount) return null;
  return toEvent(res.rows[0]);
}

export async function listSkillLifecycleEvents(params: {
  pool: Q;
  tenantId: string;
  skillName?: string;
  scopeType?: SkillScopeType;
  scopeId?: string;
  limit?: number;
}): Promise<SkillLifecycleEventRow[]> {
  const args: any[] = [params.tenantId];
  let where = "tenant_id=$1";
  if (params.skillName) {
    args.push(params.skillName);
    where += ` AND skill_name=$${args.length}`;
  }
  if (params.scopeType) {
    args.push(params.scopeType);
    where += ` AND scope_type=$${args.length}`;
  }
  if (params.scopeId) {
    args.push(params.scopeId);
    where += ` AND scope_id=$${args.length}`;
  }
  const limit = Math.min(params.limit ?? 100, 500);
  args.push(limit);
  const res = await params.pool.query(
    `SELECT * FROM skill_lifecycle_events WHERE ${where} ORDER BY created_at DESC LIMIT $${args.length}`,
    args,
  );
  return res.rows.map(toEvent);
}

/**
 * Check if a skill is enabled at the given scope level.
 * Resolves by checking from most-specific scope to least-specific.
 */
export async function isSkillEnabled(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  scopeType: SkillScopeType;
  scopeId: string;
  subjectId?: string;
}): Promise<{ enabled: boolean; status: SkillLifecycleStatus | null; scope: SkillScopeType | null }> {
  // Check from most specific to least
  const scopeChecks: { scopeType: SkillScopeType; scopeId: string }[] = [];

  if (params.scopeType === "user" && params.subjectId) {
    scopeChecks.push({ scopeType: "user", scopeId: params.subjectId });
  }
  if (params.scopeType === "space" || params.scopeType === "user") {
    scopeChecks.push({ scopeType: "space", scopeId: params.scopeId });
  }
  scopeChecks.push({ scopeType: "tenant", scopeId: params.tenantId });

  for (const check of scopeChecks) {
    const latest = await getLatestSkillStatus({
      pool: params.pool,
      tenantId: params.tenantId,
      skillName: params.skillName,
      scopeType: check.scopeType,
      scopeId: check.scopeId,
    });
    if (latest) {
      if (latest.toStatus === "revoked" || latest.toStatus === "disabled") {
        return { enabled: false, status: latest.toStatus, scope: check.scopeType };
      }
      if (latest.toStatus.startsWith("enabled_")) {
        return { enabled: true, status: latest.toStatus, scope: check.scopeType };
      }
    }
  }

  return { enabled: false, status: null, scope: null };
}

/**
 * Get a summary of all skills and their current status for a tenant
 */
export async function getSkillStatusSummary(params: {
  pool: Q;
  tenantId: string;
}): Promise<Array<{ skillName: string; latestStatus: SkillLifecycleStatus; scopeType: SkillScopeType; scopeId: string; updatedAt: string }>> {
  const res = await params.pool.query(
    `SELECT DISTINCT ON (skill_name) skill_name, to_status, scope_type, scope_id, created_at
     FROM skill_lifecycle_events
     WHERE tenant_id=$1
     ORDER BY skill_name, created_at DESC`,
    [params.tenantId],
  );
  return res.rows.map((r: any) => ({
    skillName: r.skill_name,
    latestStatus: r.to_status as SkillLifecycleStatus,
    scopeType: r.scope_type as SkillScopeType,
    scopeId: r.scope_id,
    updatedAt: r.created_at,
  }));
}

/**
 * Transition a skill to a new status with validation
 */
export async function transitionSkillStatus(params: {
  pool: Q;
  tenantId: string;
  skillName: string;
  skillVersion?: string;
  toStatus: SkillLifecycleStatus;
  scopeType: SkillScopeType;
  scopeId: string;
  changedBy: string;
  approvalId?: string;
  reason?: string;
}): Promise<SkillLifecycleEventRow> {
  const latest = await getLatestSkillStatus({
    pool: params.pool,
    tenantId: params.tenantId,
    skillName: params.skillName,
    scopeType: params.scopeType,
    scopeId: params.scopeId,
  });
  const fromStatus = latest?.toStatus ?? null;

  return recordLifecycleEvent({
    pool: params.pool,
    tenantId: params.tenantId,
    skillName: params.skillName,
    skillVersion: params.skillVersion,
    fromStatus,
    toStatus: params.toStatus,
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    changedBy: params.changedBy,
    approvalId: params.approvalId,
    reason: params.reason,
  });
}
