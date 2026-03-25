import type { Pool } from "pg";

export type ToolLimit = {
  tenantId: string;
  toolRef: string;
  defaultMaxConcurrency: number;
  createdAt: string;
  updatedAt: string;
};

export type ToolLimitOverride = {
  tenantId: string;
  spaceId: string;
  toolRef: string;
  defaultMaxConcurrency: number;
  createdAt: string;
  updatedAt: string;
};

function toToolLimit(r: any): ToolLimit {
  return {
    tenantId: r.tenant_id,
    toolRef: r.tool_ref,
    defaultMaxConcurrency: Number(r.default_max_concurrency),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toToolLimitOverride(r: any): ToolLimitOverride {
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    toolRef: r.tool_ref,
    defaultMaxConcurrency: Number(r.default_max_concurrency),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getToolLimit(params: { pool: Pool; tenantId: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_limits
      WHERE tenant_id = $1 AND tool_ref = $2
      LIMIT 1
    `,
    [params.tenantId, params.toolRef],
  );
  if (!res.rowCount) return null;
  return toToolLimit(res.rows[0]);
}

export async function getToolLimitOverride(params: { pool: Pool; tenantId: string; spaceId: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_limits_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.toolRef],
  );
  if (!res.rowCount) return null;
  return toToolLimitOverride(res.rows[0]);
}

export async function listToolLimits(params: { pool: Pool; tenantId: string; limit?: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_limits
      WHERE tenant_id = $1
      ORDER BY tool_ref ASC
      LIMIT $2
    `,
    [params.tenantId, Math.min(Math.max(params.limit ?? 200, 1), 500)],
  );
  return res.rows.map(toToolLimit);
}

export async function upsertToolLimit(params: { pool: Pool; tenantId: string; toolRef: string; defaultMaxConcurrency: number }) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_limits (tenant_id, tool_ref, default_max_concurrency)
      VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, tool_ref)
      DO UPDATE SET
        default_max_concurrency = EXCLUDED.default_max_concurrency,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.toolRef, params.defaultMaxConcurrency],
  );
  return toToolLimit(res.rows[0]);
}

export async function upsertToolLimitOverride(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  toolRef: string;
  defaultMaxConcurrency: number;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_limits_overrides (tenant_id, space_id, tool_ref, default_max_concurrency)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, space_id, tool_ref)
      DO UPDATE SET
        default_max_concurrency = EXCLUDED.default_max_concurrency,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.toolRef, params.defaultMaxConcurrency],
  );
  return toToolLimitOverride(res.rows[0]);
}

export async function deleteToolLimitOverride(params: { pool: Pool; tenantId: string; spaceId: string; toolRef: string }) {
  await params.pool.query(
    `
      DELETE FROM tool_limits_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3
    `,
    [params.tenantId, params.spaceId, params.toolRef],
  );
}

export async function getEffectiveToolLimit(params: { pool: Pool; tenantId: string; toolRef: string; spaceId?: string | null }) {
  const spaceId = params.spaceId ?? null;
  if (spaceId) {
    const o = await getToolLimitOverride({ pool: params.pool, tenantId: params.tenantId, spaceId, toolRef: params.toolRef });
    if (o) {
      const { tenantId, toolRef, defaultMaxConcurrency, createdAt, updatedAt } = o;
      return { tenantId, toolRef, defaultMaxConcurrency, createdAt, updatedAt };
    }
  }
  return getToolLimit({ pool: params.pool, tenantId: params.tenantId, toolRef: params.toolRef });
}
