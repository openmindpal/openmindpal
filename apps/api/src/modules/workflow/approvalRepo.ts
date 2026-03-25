import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type ApprovalRow = {
  approvalId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId: string | null;
  status: string;
  requestedBySubjectId: string;
  toolRef: string | null;
  policySnapshotRef: string | null;
  inputDigest: any;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalDecisionRow = {
  decisionId: string;
  approvalId: string;
  tenantId: string;
  decision: string;
  reason: string | null;
  decidedBySubjectId: string;
  decidedAt: string;
};

function toApproval(r: any): ApprovalRow {
  return {
    approvalId: r.approval_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    runId: r.run_id,
    stepId: r.step_id ?? null,
    status: r.status,
    requestedBySubjectId: r.requested_by_subject_id,
    toolRef: r.tool_ref ?? null,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    inputDigest: r.input_digest ?? null,
    requestedAt: r.requested_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDecision(r: any): ApprovalDecisionRow {
  return {
    decisionId: r.decision_id,
    approvalId: r.approval_id,
    tenantId: r.tenant_id,
    decision: r.decision,
    reason: r.reason ?? null,
    decidedBySubjectId: r.decided_by_subject_id,
    decidedAt: r.decided_at,
  };
}

export async function createApproval(params: {
  pool: Q;
  tenantId: string;
  spaceId?: string | null;
  runId: string;
  stepId?: string | null;
  requestedBySubjectId: string;
  toolRef?: string | null;
  policySnapshotRef?: string | null;
  inputDigest?: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO approvals (tenant_id, space_id, run_id, step_id, status, requested_by_subject_id, tool_ref, policy_snapshot_ref, input_digest)
      VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8)
      ON CONFLICT (tenant_id, run_id) DO UPDATE SET updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.runId,
      params.stepId ?? null,
      params.requestedBySubjectId,
      params.toolRef ?? null,
      params.policySnapshotRef ?? null,
      params.inputDigest ?? null,
    ],
  );
  return toApproval(res.rows[0]);
}

export async function listApprovals(params: { pool: Pool; tenantId: string; spaceId?: string; status?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  if (params.spaceId) {
    args.push(params.spaceId);
    where.push(`space_id = $${args.length}`);
  }
  if (params.status) {
    args.push(params.status);
    where.push(`status = $${args.length}`);
  }
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM approvals
      WHERE ${where.join(" AND ")}
      ORDER BY requested_at DESC
      LIMIT $${args.length}
    `,
    args,
  );
  return res.rows.map(toApproval);
}

export async function getApproval(params: { pool: Pool; tenantId: string; approvalId: string }) {
  const res = await params.pool.query("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 LIMIT 1", [
    params.tenantId,
    params.approvalId,
  ]);
  if (!res.rowCount) return null;
  return toApproval(res.rows[0]);
}

export async function addDecision(params: {
  pool: Q;
  tenantId: string;
  approvalId: string;
  decision: "approve" | "reject";
  reason?: string | null;
  decidedBySubjectId: string;
}) {
  const existing = await params.pool.query("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 FOR UPDATE", [params.tenantId, params.approvalId]);
  if (!existing.rowCount) return null;
  const approval = toApproval(existing.rows[0]);
  if (approval.status !== "pending") return { ok: false as const, approval };

  const decisionRes = await params.pool.query(
    `
      INSERT INTO approval_decisions (approval_id, tenant_id, decision, reason, decided_by_subject_id)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `,
    [approval.approvalId, params.tenantId, params.decision, params.reason ?? null, params.decidedBySubjectId],
  );
  const nextStatus = params.decision === "approve" ? "approved" : "rejected";
  const updated = await params.pool.query(
    "UPDATE approvals SET status = $3, updated_at = now() WHERE tenant_id = $1 AND approval_id = $2 RETURNING *",
    [params.tenantId, params.approvalId, nextStatus],
  );
  return { ok: true as const, approval: toApproval(updated.rows[0]), decision: toDecision(decisionRes.rows[0]) };
}
