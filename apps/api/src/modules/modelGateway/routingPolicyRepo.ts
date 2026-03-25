import type { Pool } from "pg";

export type RoutingPolicy = {
  tenantId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RoutingPolicyOverride = {
  tenantId: string;
  spaceId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

function toPolicy(r: any): RoutingPolicy {
  return {
    tenantId: r.tenant_id,
    purpose: r.purpose,
    primaryModelRef: r.primary_model_ref,
    fallbackModelRefs: Array.isArray(r.fallback_model_refs) ? r.fallback_model_refs : [],
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPolicyOverride(r: any): RoutingPolicyOverride {
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    purpose: r.purpose,
    primaryModelRef: r.primary_model_ref,
    fallbackModelRefs: Array.isArray(r.fallback_model_refs) ? r.fallback_model_refs : [],
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listRoutingPolicies(params: { pool: Pool; tenantId: string; limit?: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies
      WHERE tenant_id = $1
      ORDER BY purpose ASC
      LIMIT $2
    `,
    [params.tenantId, Math.min(Math.max(params.limit ?? 200, 1), 500)],
  );
  return res.rows.map(toPolicy);
}

export async function getRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies
      WHERE tenant_id = $1 AND purpose = $2
      LIMIT 1
    `,
    [params.tenantId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicy(res.rows[0]);
}

export async function getRoutingPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM routing_policies_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicyOverride(res.rows[0]);
}

export async function upsertRoutingPolicyOverride(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
}) {
  const fallbacksJson = JSON.stringify(params.fallbackModelRefs ?? []);
  const res = await params.pool.query(
    `
      INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (tenant_id, space_id, purpose)
      DO UPDATE SET
        primary_model_ref = EXCLUDED.primary_model_ref,
        fallback_model_refs = EXCLUDED.fallback_model_refs,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.purpose, params.primaryModelRef, fallbacksJson, params.enabled],
  );
  return toPolicyOverride(res.rows[0]);
}

export async function deleteRoutingPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; purpose: string }) {
  await params.pool.query(
    `
      DELETE FROM routing_policies_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3
    `,
    [params.tenantId, params.spaceId, params.purpose],
  );
}

export async function getEffectiveRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string; spaceId?: string | null }) {
  const spaceId = params.spaceId ?? null;
  if (spaceId) {
    const o = await getRoutingPolicyOverride({ pool: params.pool, tenantId: params.tenantId, spaceId, purpose: params.purpose });
    if (o) {
      const { tenantId, purpose, primaryModelRef, fallbackModelRefs, enabled, createdAt, updatedAt } = o;
      return { tenantId, purpose, primaryModelRef, fallbackModelRefs, enabled, createdAt, updatedAt };
    }
  }
  return getRoutingPolicy({ pool: params.pool, tenantId: params.tenantId, purpose: params.purpose });
}

export async function upsertRoutingPolicy(params: {
  pool: Pool;
  tenantId: string;
  purpose: string;
  primaryModelRef: string;
  fallbackModelRefs: string[];
  enabled: boolean;
}) {
  const fallbacksJson = JSON.stringify(params.fallbackModelRefs ?? []);
  const res = await params.pool.query(
    `
      INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (tenant_id, purpose)
      DO UPDATE SET
        primary_model_ref = EXCLUDED.primary_model_ref,
        fallback_model_refs = EXCLUDED.fallback_model_refs,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.purpose, params.primaryModelRef, fallbacksJson, params.enabled],
  );
  return toPolicy(res.rows[0]);
}

export async function disableRoutingPolicy(params: { pool: Pool; tenantId: string; purpose: string }) {
  const res = await params.pool.query(
    `
      UPDATE routing_policies
      SET enabled = false, updated_at = now()
      WHERE tenant_id = $1 AND purpose = $2
      RETURNING *
    `,
    [params.tenantId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toPolicy(res.rows[0]);
}
