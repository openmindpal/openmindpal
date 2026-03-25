import type { Pool, PoolClient } from "pg";
import crypto from "node:crypto";
import { decryptJson, encryptJson, type EncryptedPayload } from "../secrets/crypto";

type Q = Pool | PoolClient;

export type PartitionKeyRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  keyVersion: number;
  status: string;
  encryptedKey: EncryptedPayload;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

function toRow(r: any): PartitionKeyRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    keyVersion: Number(r.key_version),
    status: r.status,
    encryptedKey: r.encrypted_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    disabledAt: r.disabled_at ?? null,
  };
}

function randomKeyBytes() {
  return crypto.randomBytes(32);
}

export async function getActivePartitionKey(params: { pool: Q; tenantId: string; scopeType: string; scopeId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM partition_keys
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active'
      ORDER BY key_version DESC
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getPartitionKey(params: { pool: Q; tenantId: string; scopeType: string; scopeId: string; keyVersion: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM partition_keys
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND key_version = $4
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.keyVersion],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function initPartitionKey(params: { pool: Q; tenantId: string; scopeType: string; scopeId: string; masterKey: string }) {
  const existing = await getActivePartitionKey(params);
  if (existing) return existing;
  const cur = await params.pool.query(
    `SELECT key_version FROM partition_keys WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 ORDER BY key_version DESC LIMIT 1`,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  const nextVersion = cur.rowCount ? Number(cur.rows[0].key_version) + 1 : 1;
  const keyBytes = randomKeyBytes();
  const encryptedKey = encryptJson(params.masterKey, { k: keyBytes.toString("base64") });
  const res = await params.pool.query(
    `
      INSERT INTO partition_keys (tenant_id, scope_type, scope_id, key_version, status, encrypted_key)
      VALUES ($1,$2,$3,$4,'active',$5)
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, nextVersion, encryptedKey],
  );
  return toRow(res.rows[0]);
}

export async function rotatePartitionKey(params: { pool: Pool; tenantId: string; scopeType: string; scopeId: string; masterKey: string }) {
  await params.pool.query("BEGIN");
  try {
    const cur = await params.pool.query(
      `SELECT key_version FROM partition_keys WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 ORDER BY key_version DESC LIMIT 1 FOR UPDATE`,
      [params.tenantId, params.scopeType, params.scopeId],
    );
    const nextVersion = cur.rowCount ? Number(cur.rows[0].key_version) + 1 : 1;
    await params.pool.query(
      `UPDATE partition_keys SET status = 'retired', updated_at = now() WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active'`,
      [params.tenantId, params.scopeType, params.scopeId],
    );
    const keyBytes = randomKeyBytes();
    const encryptedKey = encryptJson(params.masterKey, { k: keyBytes.toString("base64") });
    const res = await params.pool.query(
      `
        INSERT INTO partition_keys (tenant_id, scope_type, scope_id, key_version, status, encrypted_key)
        VALUES ($1,$2,$3,$4,'active',$5)
        RETURNING *
      `,
      [params.tenantId, params.scopeType, params.scopeId, nextVersion, encryptedKey],
    );
    await params.pool.query("COMMIT");
    return toRow(res.rows[0]);
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function disablePartitionKey(params: { pool: Pool; tenantId: string; scopeType: string; scopeId: string; keyVersion: number }) {
  const res = await params.pool.query(
    `
      UPDATE partition_keys
      SET status = 'disabled', disabled_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND key_version = $4
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.keyVersion],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export function decryptPartitionKeyMaterial(params: { masterKey: string; encryptedKey: EncryptedPayload }) {
  const obj = decryptJson(params.masterKey, params.encryptedKey) as any;
  const b64 = typeof obj?.k === "string" ? obj.k : "";
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== 32) throw new Error("invalid_partition_key");
  return bytes;
}
