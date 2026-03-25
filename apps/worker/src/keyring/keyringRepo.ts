import type { Pool } from "pg";
import { decryptJson, type EncryptedPayload } from "../secrets/crypto";

export type PartitionKeyRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  keyVersion: number;
  status: string;
  encryptedKey: EncryptedPayload;
};

export async function getPartitionKey(params: { pool: Pool; tenantId: string; scopeType: string; scopeId: string; keyVersion: number }) {
  const res = await params.pool.query(
    "SELECT tenant_id, scope_type, scope_id, key_version, status, encrypted_key FROM partition_keys WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND key_version = $4 LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId, params.keyVersion],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    tenantId: r.tenant_id as string,
    scopeType: r.scope_type as string,
    scopeId: r.scope_id as string,
    keyVersion: Number(r.key_version),
    status: r.status as string,
    encryptedKey: r.encrypted_key as any,
  } satisfies PartitionKeyRow;
}

export function decryptPartitionKeyMaterial(params: { masterKey: string; encryptedKey: EncryptedPayload }) {
  const obj = decryptJson(params.masterKey, params.encryptedKey) as any;
  const b64 = typeof obj?.k === "string" ? obj.k : "";
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length !== 32) throw new Error("invalid_partition_key");
  return bytes;
}

