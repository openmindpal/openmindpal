import type { Pool } from "pg";

export async function ensureSubject(params: { pool: Pool; tenantId: string; subjectId: string }) {
  const res = await params.pool.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [params.subjectId]);
  if (res.rowCount) {
    const tenantId = String(res.rows[0].tenant_id ?? "");
    if (tenantId !== params.tenantId) return { ok: false as const };
    return { ok: true as const, created: false as const };
  }

  await params.pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [params.subjectId, params.tenantId]);
  return { ok: true as const, created: true as const };
}

