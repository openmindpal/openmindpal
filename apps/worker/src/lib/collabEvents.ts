import type { Pool } from "pg";

export type AppendCollabEventOnceParams = {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  type: string;
  actorRole: string | null;
  runId: string | null;
  stepId: string | null;
  payloadDigest: any;
  dedupeKeys?: Array<"runId" | "stepId">;
};

export async function appendCollabEventOnce(p: AppendCollabEventOnceParams) {
  const keys =
    p.dedupeKeys ??
    (p.runId && p.stepId ? ["runId", "stepId"] : p.runId ? ["runId"] : p.stepId ? ["stepId"] : []);

  const args: any[] = [p.tenantId, p.collabRunId, p.type];
  let where = "tenant_id = $1 AND collab_run_id = $2 AND type = $3";
  if (keys.includes("runId") && p.runId) {
    args.push(p.runId);
    where += ` AND run_id = $${args.length}`;
  }
  if (keys.includes("stepId") && p.stepId) {
    args.push(p.stepId);
    where += ` AND step_id = $${args.length}`;
  }

  const ex = await p.pool.query(`SELECT 1 FROM collab_run_events WHERE ${where} LIMIT 1`, args);
  if (ex.rowCount) return;

  await p.pool.query(
    "INSERT INTO collab_run_events (tenant_id, space_id, collab_run_id, task_id, type, actor_role, run_id, step_id, payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [p.tenantId, p.spaceId, p.collabRunId, p.taskId, p.type, p.actorRole, p.runId, p.stepId, p.payloadDigest],
  );
}

