import type { Pool, PoolClient } from "pg";

export type ProviderBinding = {
  id: string;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  modelRef: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  connectorInstanceId: string;
  secretId: string;
  secretIds: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

type Q = Pool | PoolClient;

function toBinding(r: any): ProviderBinding {
  const rawIds = r.secret_ids;
  let parsedIds: any[] = [];
  if (Array.isArray(rawIds)) parsedIds = rawIds;
  else if (typeof rawIds === "string") {
    try {
      const j = JSON.parse(rawIds);
      if (Array.isArray(j)) parsedIds = j;
    } catch {}
  } else if (rawIds && typeof rawIds === "object" && typeof (rawIds as any).toString === "function") {
    try {
      const j = JSON.parse(String((rawIds as any).toString("utf8")));
      if (Array.isArray(j)) parsedIds = j;
    } catch {}
  }
  const secretIds = parsedIds.map((x: any) => String(x)).filter(Boolean);
  const secretId = String(r.secret_id ?? "");
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    modelRef: r.model_ref,
    provider: r.provider,
    model: r.model,
    baseUrl: r.base_url ?? null,
    connectorInstanceId: r.connector_instance_id,
    secretId,
    secretIds: secretIds.length ? secretIds : secretId ? [secretId] : [],
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createBinding(params: {
  pool: Q;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  modelRef: string;
  provider: string;
  model: string;
  baseUrl?: string | null;
  connectorInstanceId: string;
  secretId: string;
  secretIds?: string[];
}) {
  const ids = Array.isArray(params.secretIds) && params.secretIds.length ? params.secretIds : [params.secretId];
  const canonIds = Array.from(new Set(ids.map((x) => String(x)).filter(Boolean)));
  const primary = canonIds[0] ?? params.secretId;
  const res = await params.pool.query(
    `
      INSERT INTO provider_bindings (
        tenant_id, scope_type, scope_id, model_ref, provider, model, base_url, connector_instance_id, secret_id, secret_ids, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'enabled'
      )
      ON CONFLICT (tenant_id, scope_type, scope_id, model_ref)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        base_url = EXCLUDED.base_url,
        connector_instance_id = EXCLUDED.connector_instance_id,
        secret_id = EXCLUDED.secret_id,
        secret_ids = EXCLUDED.secret_ids,
        status = EXCLUDED.status,
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.modelRef,
      params.provider,
      params.model,
      params.baseUrl ?? null,
      params.connectorInstanceId,
      primary,
      JSON.stringify(canonIds),
    ],
  );
  return toBinding(res.rows[0]);
}

export async function listBindings(pool: Q, tenantId: string, scopeType: string, scopeId: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM provider_bindings
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [tenantId, scopeType, scopeId],
  );
  return res.rows.map(toBinding);
}

export async function getBindingByModelRef(pool: Q, tenantId: string, scopeType: string, scopeId: string, modelRef: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM provider_bindings
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND model_ref = $4
      LIMIT 1
    `,
    [tenantId, scopeType, scopeId, modelRef],
  );
  if (!res.rowCount) return null;
  return toBinding(res.rows[0]);
}

export async function getBindingById(pool: Q, tenantId: string, id: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM provider_bindings
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenantId, id],
  );
  if (!res.rowCount) return null;
  return toBinding(res.rows[0]);
}
