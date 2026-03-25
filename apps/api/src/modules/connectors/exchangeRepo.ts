import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type ExchangeConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  oauthGrantId: string;
  mailbox: string;
  fetchWindowDays: number | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): ExchangeConnectorConfigRow {
  return {
    connectorInstanceId: r.connector_instance_id,
    tenantId: r.tenant_id,
    oauthGrantId: r.oauth_grant_id,
    mailbox: r.mailbox,
    fetchWindowDays: r.fetch_window_days ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertExchangeConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  oauthGrantId: string;
  mailbox: string;
  fetchWindowDays?: number | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO exchange_connector_configs (
        connector_instance_id, tenant_id, oauth_grant_id, mailbox, fetch_window_days
      )
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (connector_instance_id)
      DO UPDATE SET
        oauth_grant_id = EXCLUDED.oauth_grant_id,
        mailbox = EXCLUDED.mailbox,
        fetch_window_days = EXCLUDED.fetch_window_days,
        updated_at = now()
      RETURNING *
    `,
    [params.connectorInstanceId, params.tenantId, params.oauthGrantId, params.mailbox, params.fetchWindowDays ?? null],
  );
  return toRow(res.rows[0]);
}

export async function getExchangeConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM exchange_connector_configs WHERE tenant_id = $1 AND connector_instance_id = $2 LIMIT 1",
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
