import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type SmtpConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  fromAddress: string;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): SmtpConnectorConfigRow {
  return {
    connectorInstanceId: r.connector_instance_id,
    tenantId: r.tenant_id,
    host: r.host,
    port: Number(r.port),
    useTls: Boolean(r.use_tls),
    username: r.username,
    passwordSecretId: r.password_secret_id,
    fromAddress: r.from_address,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertSmtpConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  fromAddress: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO smtp_connector_configs (
        connector_instance_id, tenant_id, host, port, use_tls, username, password_secret_id, from_address
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (connector_instance_id)
      DO UPDATE SET
        host = EXCLUDED.host,
        port = EXCLUDED.port,
        use_tls = EXCLUDED.use_tls,
        username = EXCLUDED.username,
        password_secret_id = EXCLUDED.password_secret_id,
        from_address = EXCLUDED.from_address,
        updated_at = now()
      RETURNING *
    `,
    [params.connectorInstanceId, params.tenantId, params.host, params.port, params.useTls, params.username, params.passwordSecretId, params.fromAddress],
  );
  return toRow(res.rows[0]);
}

export async function getSmtpConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM smtp_connector_configs WHERE tenant_id = $1 AND connector_instance_id = $2 LIMIT 1",
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
