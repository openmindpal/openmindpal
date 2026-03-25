import type { Pool } from "pg";

export type KnowledgeRetrievalStrategyConfigV1 = {
  kind: "knowledge.retrievalStrategy.v1";
  rankPolicy: string;
  weights: { lex: number; vec: number; recency: number; metaBoost: number };
  limits: { lexicalLimit: number; embedLimit: number; metaLimit: number };
  gate?: { minHitAtK?: number; minMrrAtK?: number };
};

export type KnowledgeRetrievalStrategyRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  name: string;
  version: number;
  status: string;
  config: KnowledgeRetrievalStrategyConfigV1;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): KnowledgeRetrievalStrategyRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    spaceId: String(r.space_id),
    name: String(r.name),
    version: Number(r.version),
    status: String(r.status),
    config: r.config as any,
    createdBySubjectId: r.created_by_subject_id ? String(r.created_by_subject_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createRetrievalStrategy(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  name: string;
  config: KnowledgeRetrievalStrategyConfigV1;
  createdBySubjectId: string | null;
}) {
  const latest = await params.pool.query(
    "SELECT version FROM knowledge_retrieval_strategies WHERE tenant_id=$1 AND space_id=$2 AND name=$3 ORDER BY version DESC LIMIT 1",
    [params.tenantId, params.spaceId, params.name],
  );
  const nextVersion = (latest.rowCount ? Number(latest.rows[0].version) : 0) + 1;
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_strategies
        (tenant_id, space_id, name, version, status, config, created_by_subject_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,'draft',$5::jsonb,$6,now(),now())
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.name, nextVersion, JSON.stringify(params.config), params.createdBySubjectId],
  );
  return toRow(res.rows[0]);
}

export async function listRetrievalStrategies(params: { pool: Pool; tenantId: string; spaceId: string; limit: number; offset: number }) {
  const res = await params.pool.query(
    `
      SELECT * FROM knowledge_retrieval_strategies
      WHERE tenant_id=$1 AND space_id=$2
      ORDER BY updated_at DESC
      LIMIT $3 OFFSET $4
    `,
    [params.tenantId, params.spaceId, params.limit, params.offset],
  );
  return (res.rows as any[]).map(toRow);
}

export async function getRetrievalStrategy(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    "SELECT * FROM knowledge_retrieval_strategies WHERE tenant_id=$1 AND space_id=$2 AND id=$3 LIMIT 1",
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getActiveRetrievalStrategy(params: { pool: Pool; tenantId: string; spaceId: string }) {
  const res = await params.pool.query(
    `
      SELECT s.*
      FROM knowledge_retrieval_strategy_actives a
      JOIN knowledge_retrieval_strategies s
        ON s.id = a.strategy_id AND s.tenant_id = a.tenant_id AND s.space_id = a.space_id
      WHERE a.tenant_id=$1 AND a.space_id=$2
      LIMIT 1
    `,
    [params.tenantId, params.spaceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function activateRetrievalStrategy(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_strategy_actives (tenant_id, space_id, strategy_id, updated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT (tenant_id, space_id)
      DO UPDATE SET strategy_id = EXCLUDED.strategy_id, updated_at = now()
    `,
    [params.tenantId, params.spaceId, params.id],
  );
}

export type StrategyEvalRunRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  evalSetId: string;
  status: string;
  strategies: any;
  metrics: any;
  results: any;
  failures: any;
  createdAt: string;
};

export async function createStrategyEvalRun(params: { pool: Pool; tenantId: string; spaceId: string; evalSetId: string; strategyIds: string[]; createdBySubjectId: string | null }) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_strategy_eval_runs
        (tenant_id, space_id, eval_set_id, status, started_at, strategies, created_by_subject_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,'running',now(),$4::jsonb,$5,now(),now())
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.evalSetId, JSON.stringify({ strategyIds: params.strategyIds }), params.createdBySubjectId],
  );
  return res.rows[0] as any;
}

export async function setStrategyEvalRunFinished(params: { pool: Pool; tenantId: string; spaceId: string; runId: string; status: string; metrics: any; results: any; failures: any }) {
  const res = await params.pool.query(
    `
      UPDATE knowledge_retrieval_strategy_eval_runs
      SET status=$4, finished_at=now(), metrics=$5::jsonb, results=$6::jsonb, failures=$7::jsonb, updated_at=now()
      WHERE tenant_id=$1 AND space_id=$2 AND id=$3
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.runId, params.status, JSON.stringify(params.metrics), JSON.stringify(params.results), JSON.stringify(params.failures)],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}

export async function listStrategyEvalRuns(params: { pool: Pool; tenantId: string; spaceId: string; evalSetId?: string; limit: number; offset: number }) {
  const where: string[] = ["tenant_id=$1", "space_id=$2"];
  const values: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  if (params.evalSetId) {
    where.push(`eval_set_id = $${idx++}`);
    values.push(params.evalSetId);
  }
  where.push(`TRUE`);
  values.push(params.limit);
  values.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT * FROM knowledge_retrieval_strategy_eval_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    values,
  );
  return res.rows as any[];
}

export async function getStrategyEvalRun(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    "SELECT * FROM knowledge_retrieval_strategy_eval_runs WHERE tenant_id=$1 AND space_id=$2 AND id=$3 LIMIT 1",
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}

export async function getLatestStrategyEvalSummary(params: { pool: Pool; tenantId: string; spaceId: string; strategyId: string }) {
  const res = await params.pool.query(
    `
      SELECT metrics, created_at
      FROM knowledge_retrieval_strategy_eval_runs
      WHERE tenant_id=$1 AND space_id=$2 AND status='succeeded'
        AND strategies->'strategyIds' @> to_jsonb(ARRAY[$3]::text[])
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.strategyId],
  );
  if (!res.rowCount) return null;
  return { metrics: res.rows[0].metrics as any, createdAt: res.rows[0].created_at as string };
}
