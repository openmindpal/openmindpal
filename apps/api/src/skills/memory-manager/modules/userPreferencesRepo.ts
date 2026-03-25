import type { Pool } from "pg";

export async function getUserLocalePreference(params: { pool: Pool; tenantId: string; subjectId: string }) {
  const res = await params.pool.query(
    `
      SELECT pref_value
      FROM memory_user_preferences
      WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'locale'
      LIMIT 1
    `,
    [params.tenantId, params.subjectId],
  );
  if (!res.rowCount) return null;
  const v = res.rows[0].pref_value;
  return typeof v === "string" && v.trim() ? v : null;
}

export async function setUserLocalePreference(params: { pool: Pool; tenantId: string; subjectId: string; locale: string }) {
  const locale = params.locale.trim();
  const res = await params.pool.query(
    `
      INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
      VALUES ($1,$2,'locale',$3::jsonb,now())
      ON CONFLICT (tenant_id, subject_id, pref_key)
      DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
      RETURNING pref_value
    `,
    [params.tenantId, params.subjectId, JSON.stringify(locale)],
  );
  const v = res.rows[0].pref_value;
  return typeof v === "string" && v.trim() ? v : locale;
}

function viewPrefKey(params: { spaceId: string | null; pageName: string }) {
  const scope = params.spaceId ? `space:${params.spaceId}` : "tenant";
  return `ui.view_pref:${scope}:${params.pageName}`;
}

export async function getUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query(
    `
      SELECT pref_value
      FROM memory_user_preferences
      WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3
      LIMIT 1
    `,
    [params.tenantId, params.subjectId, key],
  );
  if (!res.rowCount) return null;
  const v = res.rows[0].pref_value;
  return v && typeof v === "object" ? (v as any) : null;
}

export async function setUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string; prefs: any }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query(
    `
      INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
      VALUES ($1,$2,$3,$4::jsonb,now())
      ON CONFLICT (tenant_id, subject_id, pref_key)
      DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
      RETURNING pref_value
    `,
    [params.tenantId, params.subjectId, key, JSON.stringify(params.prefs ?? {})],
  );
  return res.rows[0].pref_value as any;
}

export async function resetUserPageViewPrefs(params: { pool: Pool; tenantId: string; subjectId: string; spaceId: string | null; pageName: string }) {
  const key = viewPrefKey({ spaceId: params.spaceId, pageName: params.pageName });
  const res = await params.pool.query("DELETE FROM memory_user_preferences WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = $3", [
    params.tenantId,
    params.subjectId,
    key,
  ]);
  return Boolean(res.rowCount);
}
