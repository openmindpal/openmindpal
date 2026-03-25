import type { Pool } from "pg";

export type ModelBudget = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  purpose: string;
  softDailyTokens: number | null;
  hardDailyTokens: number | null;
  updatedAt: string;
};

function toRow(r: any): ModelBudget {
  return {
    tenantId: String(r.tenant_id),
    scopeType: String(r.scope_type) === "tenant" ? "tenant" : "space",
    scopeId: String(r.scope_id),
    purpose: String(r.purpose),
    softDailyTokens: typeof r.soft_daily_tokens === "number" ? r.soft_daily_tokens : r.soft_daily_tokens == null ? null : Number(r.soft_daily_tokens),
    hardDailyTokens: typeof r.hard_daily_tokens === "number" ? r.hard_daily_tokens : r.hard_daily_tokens == null ? null : Number(r.hard_daily_tokens),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getModelBudget(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string; purpose: string }) {
  const res = await params.pool.query(
    "SELECT * FROM model_budgets WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND purpose = $4 LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId, params.purpose],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getEffectiveModelBudget(params: { pool: Pool; tenantId: string; spaceId?: string | null; purpose: string }) {
  if (params.spaceId) {
    const s = await getModelBudget({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: params.spaceId, purpose: params.purpose });
    if (s) return s;
  }
  return getModelBudget({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId, purpose: params.purpose });
}

export async function upsertModelBudget(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  purpose: string;
  softDailyTokens: number | null;
  hardDailyTokens: number | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO model_budgets (tenant_id, scope_type, scope_id, purpose, soft_daily_tokens, hard_daily_tokens)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, scope_type, scope_id, purpose) DO UPDATE
      SET soft_daily_tokens = EXCLUDED.soft_daily_tokens,
          hard_daily_tokens = EXCLUDED.hard_daily_tokens,
          updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.purpose, params.softDailyTokens, params.hardDailyTokens],
  );
  return toRow(res.rows[0]);
}

export async function listModelBudgets(params: { pool: Pool; tenantId: string; scopeType?: "tenant" | "space"; scopeId?: string; purpose?: string }) {
  const where: string[] = ["tenant_id = $1"];
  const vals: any[] = [params.tenantId];
  if (params.scopeType) {
    vals.push(params.scopeType);
    where.push(`scope_type = $${vals.length}`);
  }
  if (params.scopeId) {
    vals.push(params.scopeId);
    where.push(`scope_id = $${vals.length}`);
  }
  if (params.purpose) {
    vals.push(params.purpose);
    where.push(`purpose = $${vals.length}`);
  }
  const res = await params.pool.query(`SELECT * FROM model_budgets WHERE ${where.join(" AND ")} ORDER BY scope_type ASC, scope_id ASC, purpose ASC`, vals);
  return res.rows.map(toRow);
}

