import type { Pool } from "pg";

export type SubscriptionRunRow = {
  runId: string;
  subscriptionId: string;
  tenantId: string;
  status: string;
  traceId: string;
  watermarkBefore: any;
  watermarkAfter: any;
  eventCount: number;
  errorCategory: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
};

function toRow(r: any): SubscriptionRunRow {
  return {
    runId: r.run_id,
    subscriptionId: r.subscription_id,
    tenantId: r.tenant_id,
    status: r.status,
    traceId: r.trace_id,
    watermarkBefore: r.watermark_before ?? null,
    watermarkAfter: r.watermark_after ?? null,
    eventCount: Number(r.event_count ?? 0),
    errorCategory: r.error_category ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
  };
}

export async function appendSubscriptionRun(params: { pool: Pool; tenantId: string; subscriptionId: string; status: string; traceId: string; watermarkBefore?: any }) {
  const res = await params.pool.query(
    `
      INSERT INTO subscription_runs (subscription_id, tenant_id, status, trace_id, watermark_before)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `,
    [params.subscriptionId, params.tenantId, params.status, params.traceId, params.watermarkBefore ?? null],
  );
  return toRow(res.rows[0]);
}

export async function getLastRunBySubscription(params: { pool: Pool; tenantId: string; subscriptionId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM subscription_runs
      WHERE tenant_id = $1 AND subscription_id = $2
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.subscriptionId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

