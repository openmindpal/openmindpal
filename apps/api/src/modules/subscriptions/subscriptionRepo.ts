import type { Pool } from "pg";

export type SubscriptionRow = {
  subscriptionId: string;
  tenantId: string;
  spaceId: string | null;
  provider: string;
  connectorInstanceId: string | null;
  status: string;
  pollIntervalSec: number;
  watermark: any;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): SubscriptionRow {
  return {
    subscriptionId: r.subscription_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    provider: r.provider,
    connectorInstanceId: r.connector_instance_id ?? null,
    status: r.status,
    pollIntervalSec: Number(r.poll_interval_sec),
    watermark: r.watermark ?? null,
    lastRunAt: r.last_run_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createSubscription(params: { pool: Pool; tenantId: string; spaceId?: string | null; provider: string; connectorInstanceId?: string | null; pollIntervalSec: number; watermark?: any }) {
  const res = await params.pool.query(
    `
      INSERT INTO subscriptions (tenant_id, space_id, provider, connector_instance_id, status, poll_interval_sec, watermark)
      VALUES ($1,$2,$3,$4,'enabled',$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.spaceId ?? null, params.provider, params.connectorInstanceId ?? null, params.pollIntervalSec, params.watermark ?? null],
  );
  return toRow(res.rows[0]);
}

export async function getSubscription(params: { pool: Pool; tenantId: string; subscriptionId: string }) {
  const res = await params.pool.query("SELECT * FROM subscriptions WHERE tenant_id = $1 AND subscription_id = $2 LIMIT 1", [params.tenantId, params.subscriptionId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listSubscriptions(params: { pool: Pool; tenantId: string; spaceId: string | null; limit: number; offset: number }) {
  if (params.spaceId) {
    const res = await params.pool.query(
      `
        SELECT *
        FROM subscriptions
        WHERE tenant_id = $1 AND space_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `,
      [params.tenantId, params.spaceId, params.limit, params.offset],
    );
    return res.rows.map(toRow);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM subscriptions
      WHERE tenant_id = $1 AND space_id IS NULL
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [params.tenantId, params.limit, params.offset],
  );
  return res.rows.map(toRow);
}

export async function setSubscriptionStatus(params: { pool: Pool; tenantId: string; subscriptionId: string; status: "enabled" | "disabled" }) {
  const res = await params.pool.query(
    `
      UPDATE subscriptions
      SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND subscription_id = $2
      RETURNING *
    `,
    [params.tenantId, params.subscriptionId, params.status],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
