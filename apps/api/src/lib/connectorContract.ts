/**
 * Connector Contract — kernel-level connector instance/type lookup.
 *
 * This module lives in lib/ so that kernel routes (audit.ts, secrets.ts)
 * can query connector data WITHOUT importing from the connector-manager Skill.
 */
import type { Pool } from "pg";

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

export async function getConnectorType(pool: Pool, name: string) {
  const res = await pool.query("SELECT * FROM connector_types WHERE name = $1 LIMIT 1", [name]);
  if (!res.rowCount) return null;
  return toType(res.rows[0]);
}

export async function getConnectorInstance(pool: Pool, tenantId: string, id: string) {
  const res = await pool.query("SELECT * FROM connector_instances WHERE tenant_id = $1 AND id = $2 LIMIT 1", [tenantId, id]);
  if (!res.rowCount) return null;
  return toInstance(res.rows[0]);
}
