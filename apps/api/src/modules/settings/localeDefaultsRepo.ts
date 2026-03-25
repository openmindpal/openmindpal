import type { Pool } from "pg";

export async function getTenantDefaultLocale(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT default_locale FROM tenants WHERE id = $1 LIMIT 1", [params.tenantId]);
  if (!res.rowCount) return null;
  return res.rows[0].default_locale as string;
}

export async function setTenantDefaultLocale(params: { pool: Pool; tenantId: string; defaultLocale: string }) {
  const res = await params.pool.query("UPDATE tenants SET default_locale = $2 WHERE id = $1 RETURNING default_locale", [
    params.tenantId,
    params.defaultLocale,
  ]);
  if (!res.rowCount) return null;
  return res.rows[0].default_locale as string;
}

export async function getSpaceDefaultLocale(params: { pool: Pool; tenantId: string; spaceId: string }) {
  const res = await params.pool.query("SELECT default_locale FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [params.spaceId, params.tenantId]);
  if (!res.rowCount) return null;
  return res.rows[0].default_locale as string;
}

export async function setSpaceDefaultLocale(params: { pool: Pool; tenantId: string; spaceId: string; defaultLocale: string }) {
  const res = await params.pool.query(
    "UPDATE spaces SET default_locale = $3 WHERE id = $1 AND tenant_id = $2 RETURNING default_locale",
    [params.spaceId, params.tenantId, params.defaultLocale],
  );
  if (!res.rowCount) return null;
  return res.rows[0].default_locale as string;
}

