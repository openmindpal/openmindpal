import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type ImapConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  mailbox: string;
  fetchWindowDays: number | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): ImapConnectorConfigRow {
  return {
    connectorInstanceId: r.connector_instance_id,
    tenantId: r.tenant_id,
    host: r.host,
    port: Number(r.port),
    useTls: Boolean(r.use_tls),
    username: r.username,
    passwordSecretId: r.password_secret_id,
    mailbox: r.mailbox,
    fetchWindowDays: r.fetch_window_days ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertImapConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  mailbox: string;
  fetchWindowDays?: number | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO imap_connector_configs (
        connector_instance_id, tenant_id, host, port, use_tls, username, password_secret_id, mailbox, fetch_window_days
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (connector_instance_id)
      DO UPDATE SET
        host = EXCLUDED.host,
        port = EXCLUDED.port,
        use_tls = EXCLUDED.use_tls,
        username = EXCLUDED.username,
        password_secret_id = EXCLUDED.password_secret_id,
        mailbox = EXCLUDED.mailbox,
        fetch_window_days = EXCLUDED.fetch_window_days,
        updated_at = now()
      RETURNING *
    `,
    [
      params.connectorInstanceId,
      params.tenantId,
      params.host,
      params.port,
      params.useTls,
      params.username,
      params.passwordSecretId,
      params.mailbox,
      params.fetchWindowDays ?? null,
    ],
  );
  return toRow(res.rows[0]);
}

export async function getImapConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM imap_connector_configs WHERE tenant_id = $1 AND connector_instance_id = $2 LIMIT 1",
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
