import type { Pool } from "pg";

export async function getPolicyCacheEpoch(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO policy_cache_epochs (tenant_id, scope_type, scope_id, epoch, updated_at)
      VALUES ($1,$2,$3,0,now())
      ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
      SET epoch = policy_cache_epochs.epoch
      RETURNING epoch
    `,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  return Number(res.rows[0].epoch ?? 0);
}

export async function bumpPolicyCacheEpoch(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO policy_cache_epochs (tenant_id, scope_type, scope_id, epoch, updated_at)
      VALUES ($1,$2,$3,1,now())
      ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
      SET epoch = policy_cache_epochs.epoch + 1,
          updated_at = now()
      RETURNING epoch
    `,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  const newEpoch = Number(res.rows[0].epoch);
  return { previousEpoch: newEpoch - 1, newEpoch };
}
