import type { Pool } from "pg";

// ---- Types ----

export type AgentType = "llm" | "human" | "tool_executor" | "reviewer" | "planner";

export type CollabAgentRoleRow = {
  agentRoleId: string;
  tenantId: string;
  collabRunId: string;
  roleName: string;
  agentType: AgentType;
  capabilities: any;
  constraints: any;
  status: string;
  policySnapshotRef: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CollabTaskAssignmentRow = {
  assignmentId: string;
  tenantId: string;
  collabRunId: string;
  taskId: string;
  assignedRole: string;
  assignedBy: string | null;
  priority: number;
  status: string;
  inputDigest: any;
  outputDigest: any;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CollabPermissionContextRow = {
  contextId: string;
  tenantId: string;
  collabRunId: string;
  roleName: string;
  effectivePermissions: any;
  fieldRules: any;
  rowFilters: any;
  policySnapshotRef: string | null;
  expiresAt: string | null;
  createdAt: string;
};

// ---- Mappers ----

function toRole(r: any): CollabAgentRoleRow {
  return {
    agentRoleId: String(r.agent_role_id),
    tenantId: String(r.tenant_id),
    collabRunId: String(r.collab_run_id),
    roleName: String(r.role_name),
    agentType: String(r.agent_type ?? "llm") as AgentType,
    capabilities: r.capabilities ?? [],
    constraints: r.constraints ?? {},
    status: String(r.status ?? "active"),
    policySnapshotRef: r.policy_snapshot_ref ? String(r.policy_snapshot_ref) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toAssignment(r: any): CollabTaskAssignmentRow {
  return {
    assignmentId: String(r.assignment_id),
    tenantId: String(r.tenant_id),
    collabRunId: String(r.collab_run_id),
    taskId: String(r.task_id),
    assignedRole: String(r.assigned_role),
    assignedBy: r.assigned_by ? String(r.assigned_by) : null,
    priority: Number(r.priority ?? 0),
    status: String(r.status ?? "pending"),
    inputDigest: r.input_digest ?? null,
    outputDigest: r.output_digest ?? null,
    deadlineAt: r.deadline_at ? String(r.deadline_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toPermCtx(r: any): CollabPermissionContextRow {
  return {
    contextId: String(r.context_id),
    tenantId: String(r.tenant_id),
    collabRunId: String(r.collab_run_id),
    roleName: String(r.role_name),
    effectivePermissions: r.effective_permissions ?? {},
    fieldRules: r.field_rules ?? null,
    rowFilters: r.row_filters ?? null,
    policySnapshotRef: r.policy_snapshot_ref ? String(r.policy_snapshot_ref) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    createdAt: String(r.created_at),
  };
}

// ---- Agent Roles ----

export async function registerAgentRole(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  roleName: string;
  agentType: AgentType;
  capabilities?: any;
  constraints?: any;
  policySnapshotRef?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO collab_agent_roles (tenant_id, collab_run_id, role_name, agent_type, capabilities, constraints, policy_snapshot_ref)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
      ON CONFLICT (tenant_id, collab_run_id, role_name) DO UPDATE
      SET agent_type = EXCLUDED.agent_type,
          capabilities = EXCLUDED.capabilities,
          constraints = EXCLUDED.constraints,
          policy_snapshot_ref = COALESCE(EXCLUDED.policy_snapshot_ref, collab_agent_roles.policy_snapshot_ref),
          updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.collabRunId,
      params.roleName,
      params.agentType,
      JSON.stringify(params.capabilities ?? []),
      JSON.stringify(params.constraints ?? {}),
      params.policySnapshotRef ?? null,
    ],
  );
  return toRole(res.rows[0]);
}

export async function getAgentRole(params: { pool: Pool; tenantId: string; collabRunId: string; roleName: string }) {
  const res = await params.pool.query(
    "SELECT * FROM collab_agent_roles WHERE tenant_id = $1 AND collab_run_id = $2 AND role_name = $3 LIMIT 1",
    [params.tenantId, params.collabRunId, params.roleName],
  );
  if (!res.rowCount) return null;
  return toRole(res.rows[0]);
}

export async function listAgentRoles(params: { pool: Pool; tenantId: string; collabRunId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM collab_agent_roles WHERE tenant_id = $1 AND collab_run_id = $2 ORDER BY created_at ASC",
    [params.tenantId, params.collabRunId],
  );
  return res.rows.map(toRole);
}

export async function updateAgentRoleStatus(params: { pool: Pool; tenantId: string; collabRunId: string; roleName: string; status: string }) {
  const res = await params.pool.query(
    "UPDATE collab_agent_roles SET status = $4, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2 AND role_name = $3 RETURNING *",
    [params.tenantId, params.collabRunId, params.roleName, params.status],
  );
  if (!res.rowCount) return null;
  return toRole(res.rows[0]);
}

// ---- Task Assignments ----

export async function createTaskAssignment(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  taskId: string;
  assignedRole: string;
  assignedBy?: string | null;
  priority?: number;
  inputDigest?: any;
  deadlineAt?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO collab_task_assignments (tenant_id, collab_run_id, task_id, assigned_role, assigned_by, priority, input_digest, deadline_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      RETURNING *
    `,
    [
      params.tenantId,
      params.collabRunId,
      params.taskId,
      params.assignedRole,
      params.assignedBy ?? null,
      params.priority ?? 0,
      params.inputDigest ? JSON.stringify(params.inputDigest) : null,
      params.deadlineAt ?? null,
    ],
  );
  return toAssignment(res.rows[0]);
}

export async function updateTaskAssignmentStatus(params: {
  pool: Pool;
  tenantId: string;
  assignmentId: string;
  status: string;
  outputDigest?: any;
}) {
  const res = await params.pool.query(
    `
      UPDATE collab_task_assignments
      SET status = $3, output_digest = COALESCE($4::jsonb, output_digest), updated_at = now()
      WHERE tenant_id = $1 AND assignment_id = $2
      RETURNING *
    `,
    [params.tenantId, params.assignmentId, params.status, params.outputDigest ? JSON.stringify(params.outputDigest) : null],
  );
  if (!res.rowCount) return null;
  return toAssignment(res.rows[0]);
}

export async function listTaskAssignments(params: { pool: Pool; tenantId: string; collabRunId: string; status?: string | null; limit?: number }) {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50));
  const res = await params.pool.query(
    `
      SELECT * FROM collab_task_assignments
      WHERE tenant_id = $1 AND collab_run_id = $2 AND ($3::TEXT IS NULL OR status = $3)
      ORDER BY priority DESC, created_at ASC
      LIMIT $4
    `,
    [params.tenantId, params.collabRunId, params.status ?? null, limit],
  );
  return res.rows.map(toAssignment);
}

// ---- Permission Contexts ----

export async function upsertPermissionContext(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  roleName: string;
  effectivePermissions: any;
  fieldRules?: any;
  rowFilters?: any;
  policySnapshotRef?: string | null;
  expiresAt?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO collab_permission_contexts (tenant_id, collab_run_id, role_name, effective_permissions, field_rules, row_filters, policy_snapshot_ref, expires_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
      ON CONFLICT (tenant_id, collab_run_id, role_name) DO UPDATE
      SET effective_permissions = EXCLUDED.effective_permissions,
          field_rules = COALESCE(EXCLUDED.field_rules, collab_permission_contexts.field_rules),
          row_filters = COALESCE(EXCLUDED.row_filters, collab_permission_contexts.row_filters),
          policy_snapshot_ref = COALESCE(EXCLUDED.policy_snapshot_ref, collab_permission_contexts.policy_snapshot_ref)
      RETURNING *
    `,
    [
      params.tenantId,
      params.collabRunId,
      params.roleName,
      JSON.stringify(params.effectivePermissions ?? {}),
      params.fieldRules ? JSON.stringify(params.fieldRules) : null,
      params.rowFilters ? JSON.stringify(params.rowFilters) : null,
      params.policySnapshotRef ?? null,
      params.expiresAt ?? null,
    ],
  );
  return toPermCtx(res.rows[0]);
}

export async function getPermissionContext(params: { pool: Pool; tenantId: string; collabRunId: string; roleName: string }) {
  const res = await params.pool.query(
    "SELECT * FROM collab_permission_contexts WHERE tenant_id = $1 AND collab_run_id = $2 AND role_name = $3 LIMIT 1",
    [params.tenantId, params.collabRunId, params.roleName],
  );
  if (!res.rowCount) return null;
  return toPermCtx(res.rows[0]);
}

export async function listPermissionContexts(params: { pool: Pool; tenantId: string; collabRunId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM collab_permission_contexts WHERE tenant_id = $1 AND collab_run_id = $2 ORDER BY created_at ASC",
    [params.tenantId, params.collabRunId],
  );
  return res.rows.map(toPermCtx);
}

// ---- Validation helpers ----

const VALID_AGENT_TYPES = new Set<string>(["llm", "human", "tool_executor", "reviewer", "planner"]);

export function isValidAgentType(v: string): v is AgentType {
  return VALID_AGENT_TYPES.has(v);
}

export function validateRoleConstraints(constraints: any) {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return { valid: true, constraints: {} };
  const out: any = {};
  if (typeof constraints.maxSteps === "number" && Number.isFinite(constraints.maxSteps)) out.maxSteps = Math.max(1, Math.min(100, constraints.maxSteps));
  if (typeof constraints.maxWallTimeMs === "number" && Number.isFinite(constraints.maxWallTimeMs)) out.maxWallTimeMs = Math.max(1000, Math.min(3600000, constraints.maxWallTimeMs));
  if (typeof constraints.maxTokens === "number" && Number.isFinite(constraints.maxTokens)) out.maxTokens = Math.max(1, Math.min(10_000_000, Math.round(constraints.maxTokens)));
  if (typeof constraints.maxCostUsd === "number" && Number.isFinite(constraints.maxCostUsd)) out.maxCostUsd = Math.max(0, Math.min(100_000, Number(constraints.maxCostUsd)));
  if (Array.isArray(constraints.allowedTools)) out.allowedTools = constraints.allowedTools.map(String).filter(Boolean).slice(0, 500);
  if (Array.isArray(constraints.deniedTools)) out.deniedTools = constraints.deniedTools.map(String).filter(Boolean).slice(0, 500);
  return { valid: true, constraints: out };
}
