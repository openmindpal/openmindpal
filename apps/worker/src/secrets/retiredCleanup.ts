import crypto from "node:crypto";
import type { Pool } from "pg";

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export async function tickRetiredSecretsCleanup(params: { pool: Pool }) {
  const graceRaw = String(process.env.SECRETS_ROTATION_GRACE_SEC ?? "").trim();
  const graceDefault = graceRaw ? Math.max(60, Math.round(Number(graceRaw))) : 7 * 24 * 60 * 60;

  const res = await params.pool.query(
    `
      WITH candidates AS (
        SELECT tenant_id, scope_type, scope_id, id, connector_instance_id, credential_version
        FROM secret_records
        WHERE status = 'retired'
          AND retired_at IS NOT NULL
          AND revoked_at IS NULL
          AND retired_at < now() - (COALESCE(grace_period_sec, $1)::text || ' seconds')::interval
        ORDER BY retired_at ASC, id ASC
        LIMIT 200
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE secret_records s
        SET status = 'revoked', revoked_at = now(), updated_at = now()
        FROM candidates c
        WHERE s.tenant_id = c.tenant_id AND s.id = c.id
        RETURNING c.tenant_id, c.scope_type, c.scope_id, c.id, c.connector_instance_id, c.credential_version
      )
      SELECT *
      FROM updated
    `,
    [graceDefault],
  );

  const rows = res.rows as any[];
  if (!rows.length) return { revoked: 0 };

  const byTenant = new Map<string, any[]>();
  for (const r of rows) {
    const tenantId = String(r.tenant_id ?? "");
    if (!tenantId) continue;
    const arr = byTenant.get(tenantId) ?? [];
    arr.push(r);
    byTenant.set(tenantId, arr);
  }

  for (const [tenantId, items] of byTenant) {
    const traceId = `worker:secrets.cleanup:${crypto.randomUUID()}`;
    const ids = items.map((x: any) => String(x.id ?? "")).filter(Boolean);
    const digest8 = sha256Hex(ids.join(",")).slice(0, 8);
    await params.pool.query(
      `
        INSERT INTO audit_events (subject_id, tenant_id, space_id, resource_type, action, output_digest, result, trace_id, error_category)
        VALUES (NULL, $1, NULL, 'secret', 'cleanup.retired_revoke', $2::jsonb, 'success', $3, NULL)
      `,
      [tenantId, JSON.stringify({ revoked: ids.length, idsDigest8: digest8 }) as any, traceId],
    );
  }

  return { revoked: rows.length };
}

