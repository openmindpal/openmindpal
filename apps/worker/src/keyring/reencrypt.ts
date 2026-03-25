import type { Pool } from "pg";
import { decryptSecretPayload, encryptSecretEnvelopeWithKeyVersion } from "../secrets/envelope";
export async function reencryptSecrets(params: { pool: Pool; tenantId: string; masterKey?: string; scopeType: string; scopeId: string; limit: number }) {
  const masterKey =
    String(params.masterKey ?? "").trim() ||
    String(process.env.API_MASTER_KEY ?? "").trim() ||
    (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  const active = await params.pool.query(
    "SELECT key_version FROM partition_keys WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active' ORDER BY key_version DESC LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId],
  );
  if (!active.rowCount) throw new Error("active_key_missing");
  const targetKeyVersion = Number(active.rows[0].key_version);

  const rows = await params.pool.query(
    `
      SELECT id, scope_type, scope_id, key_version, enc_format, encrypted_payload
      FROM secret_records
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active' AND enc_format = 'envelope.v1' AND key_version <> $4
      ORDER BY updated_at ASC
      LIMIT $5
    `,
    [params.tenantId, params.scopeType, params.scopeId, targetKeyVersion, params.limit],
  );

  let updated = 0;
  let failed = 0;
  for (const r of rows.rows as any[]) {
    try {
      const plain = await decryptSecretPayload({
        pool: params.pool,
        tenantId: params.tenantId,
        masterKey,
        scopeType: String(r.scope_type),
        scopeId: String(r.scope_id),
        keyVersion: Number(r.key_version),
        encFormat: String(r.enc_format ?? "legacy.a256gcm"),
        encryptedPayload: r.encrypted_payload,
      });
      const env = await encryptSecretEnvelopeWithKeyVersion({
        pool: params.pool,
        tenantId: params.tenantId,
        masterKey,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        keyVersion: targetKeyVersion,
        payload: plain,
      });
      await params.pool.query(
        "UPDATE secret_records SET encrypted_payload = $3::jsonb, key_version = $4, key_ref = $5::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2",
        [params.tenantId, r.id, JSON.stringify(env), targetKeyVersion, JSON.stringify({ scopeType: params.scopeType, scopeId: params.scopeId, keyVersion: targetKeyVersion })],
      );
      updated++;
    } catch {
      failed++;
    }
  }

  await params.pool.query(
    `
      INSERT INTO audit_events (
        subject_id, tenant_id, space_id, resource_type, action,
        input_digest, output_digest, result, trace_id, error_category, latency_ms
      )
      VALUES (NULL,$1,$2,'keyring','reencrypt',NULL,$3,'success',$4,NULL,NULL)
    `,
    [params.tenantId, params.scopeType === "space" ? params.scopeId : null, { scopeType: params.scopeType, scopeId: params.scopeId, targetKeyVersion, updated, failed }, `keyring.reencrypt:${params.tenantId}:${params.scopeType}:${params.scopeId}`],
  );

  return { targetKeyVersion, updated, failed };
}
