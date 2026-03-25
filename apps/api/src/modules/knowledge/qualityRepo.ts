import type { Pool } from "pg";

export type RetrievalEvalSetRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  name: string;
  description: string | null;
  queries: any;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RetrievalEvalRunRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  evalSetId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: any | null;
  results: any | null;
  failures: any | null;
  createdAt: string;
  updatedAt: string;
};

function toSet(r: any): RetrievalEvalSetRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    name: r.name,
    description: r.description ?? null,
    queries: r.queries,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: any): RetrievalEvalRunRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    evalSetId: r.eval_set_id,
    status: r.status,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    metrics: r.metrics ?? null,
    results: r.results ?? null,
    failures: r.failures ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createRetrievalEvalSet(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  name: string;
  description?: string | null;
  queries: any;
  createdBySubjectId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_eval_sets (tenant_id, space_id, name, description, queries, created_by_subject_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.name, params.description ?? null, JSON.stringify(params.queries ?? []), params.createdBySubjectId ?? null],
  );
  return toSet(res.rows[0]);
}

export async function listRetrievalEvalSets(params: { pool: Pool; tenantId: string; spaceId: string; limit: number; offset: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_retrieval_eval_sets
      WHERE tenant_id = $1 AND space_id = $2
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
    `,
    [params.tenantId, params.spaceId, params.limit, params.offset],
  );
  return (res.rows as any[]).map(toSet);
}

export async function getRetrievalEvalSet(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_retrieval_eval_sets
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  return toSet(res.rows[0]);
}

export async function createRetrievalEvalRun(params: { pool: Pool; tenantId: string; spaceId: string; evalSetId: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_eval_runs (tenant_id, space_id, eval_set_id, status, started_at)
      VALUES ($1, $2, $3, 'running', now())
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.evalSetId],
  );
  return toRun(res.rows[0]);
}

export async function setRetrievalEvalRunFinished(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  runId: string;
  status: "succeeded" | "failed";
  metrics: any;
  results: any;
  failures: any;
}) {
  const res = await params.pool.query(
    `
      UPDATE knowledge_retrieval_eval_runs
      SET status = $4,
          finished_at = now(),
          metrics = $5::jsonb,
          results = $6::jsonb,
          failures = $7::jsonb,
          updated_at = now()
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.runId, params.status, JSON.stringify(params.metrics ?? null), JSON.stringify(params.results ?? null), JSON.stringify(params.failures ?? null)],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function listRetrievalEvalRuns(params: { pool: Pool; tenantId: string; spaceId: string; evalSetId?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.evalSetId) {
    where.push(`eval_set_id = $${idx++}`);
    args.push(params.evalSetId);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_retrieval_eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(toRun);
}

export async function getRetrievalEvalRun(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_retrieval_eval_runs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

