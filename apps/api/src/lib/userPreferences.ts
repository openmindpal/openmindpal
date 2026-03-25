/**
 * User Preferences — kernel-level locale preference access.
 *
 * This module lives in lib/ so that plugins/preferences.ts and routes/me.ts
 * can access user locale WITHOUT importing from the memory-manager Skill.
 */
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
