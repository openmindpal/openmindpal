import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type ConnectorTypeRow = {
  name: string;
  provider: string;
  authMethod: string;
  defaultRiskLevel: string;
  defaultEgressPolicy: any;
};

export type ConnectorInstanceRow = {
  id: string;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  name: string;
  typeName: string;
  status: string;
  egressPolicy: any;
  createdAt: string;
  updatedAt: string;
};

function toType(r: any): ConnectorTypeRow {
  return {
    name: r.name,
    provider: r.provider,
    authMethod: r.auth_method,
    defaultRiskLevel: r.default_risk_level,
    defaultEgressPolicy: r.default_egress_policy,
  };
}

function toInstance(r: any): ConnectorInstanceRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    name: r.name,
    typeName: r.type_name,
    status: r.status,
    egressPolicy: r.egress_policy,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listConnectorTypes(pool: Pool) {
  const res = await pool.query("SELECT * FROM connector_types ORDER BY name ASC");
  return res.rows.map(toType);
}

export async function getConnectorType(pool: Pool, name: string) {
  const res = await pool.query("SELECT * FROM connector_types WHERE name = $1 LIMIT 1", [name]);
  if (!res.rowCount) return null;
  return toType(res.rows[0]);
}

export async function createConnectorInstance(params: {
  pool: Q;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  name: string;
  typeName: string;
  egressPolicy?: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
      VALUES ($1, $2, $3, $4, $5, 'enabled', $6)
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.name, params.typeName, params.egressPolicy ?? null],
  );
  return toInstance(res.rows[0]);
}

export async function listConnectorInstances(pool: Pool, tenantId: string, scopeType: string, scopeId: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM connector_instances
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [tenantId, scopeType, scopeId],
  );
  return res.rows.map(toInstance);
}

export async function getConnectorInstance(pool: Pool, tenantId: string, id: string) {
  const res = await pool.query("SELECT * FROM connector_instances WHERE tenant_id = $1 AND id = $2 LIMIT 1", [tenantId, id]);
  if (!res.rowCount) return null;
  return toInstance(res.rows[0]);
}

export async function getConnectorInstanceByName(pool: Q, tenantId: string, scopeType: string, scopeId: string, name: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM connector_instances
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4
      LIMIT 1
    `,
    [tenantId, scopeType, scopeId, name],
  );
  if (!res.rowCount) return null;
  return toInstance(res.rows[0]);
}

export async function setConnectorInstanceStatus(pool: Q, tenantId: string, id: string, status: "enabled" | "disabled") {
  const res = await pool.query(
    `
      UPDATE connector_instances
      SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [tenantId, id, status],
  );
  if (!res.rowCount) return null;
  return toInstance(res.rows[0]);
}
