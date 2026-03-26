import type { Pool } from "pg";

/**
 * 确保 subject 存在于数据库中。
 * 在开发模式（AUTHN_MODE !== 'pat' && AUTHN_MODE !== 'hmac'）下，
 * 如果是新创建的用户，自动授予管理员角色。
 */
export async function ensureSubject(params: { pool: Pool; tenantId: string; subjectId: string }) {
  const res = await params.pool.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [params.subjectId]);
  if (res.rowCount) {
    const tenantId = String(res.rows[0].tenant_id ?? "");
    if (tenantId !== params.tenantId) return { ok: false as const };
    return { ok: true as const, created: false as const };
  }

  await params.pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [params.subjectId, params.tenantId]);

  // 开发模式下自动为新用户授予管理员权限
  const authnMode = process.env.AUTHN_MODE ?? "dev";
  if (authnMode === "dev") {
    await grantAdminRoleToSubject(params.pool, params.tenantId, params.subjectId);
    console.log(`[dev-mode] auto-granted admin role to new subject: ${params.subjectId}`);
  }

  return { ok: true as const, created: true as const };
}

/**
 * 为指定用户授予管理员角色（如果尚未授予）
 */
async function grantAdminRoleToSubject(pool: Pool, tenantId: string, subjectId: string) {
  // 获取或创建管理员角色
  const roleRes = await pool.query(
    "INSERT INTO roles (name, tenant_id) VALUES ('admin', $1) ON CONFLICT (name, tenant_id) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [tenantId],
  );
  const adminRoleId = String(roleRes.rows[0].id);

  // 为用户绑定管理员角色
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    [subjectId, adminRoleId, tenantId],
  );
}

