import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { decryptJson, type EncryptedPayload } from "./crypto";
import { decryptPartitionKeyMaterial, getPartitionKey, initPartitionKey } from "../keyring/keyringRepo";

export type A256Gcm = { alg: "A256GCM"; iv: string; tag: string; ct: string };
export type EnvelopeV1 = {
  format: "envelope.v1";
  keyRef: { scopeType: string; scopeId: string; keyVersion: number };
  payload: A256Gcm;
  wrappedDek: A256Gcm;
};

function encryptBytes(key: Buffer, bytes: Buffer): A256Gcm {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const tag = c.getAuthTag();
  return { alg: "A256GCM", iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}

function decryptBytes(key: Buffer, enc: A256Gcm) {
  const iv = Buffer.from(enc.iv, "base64");
  const tag = Buffer.from(enc.tag, "base64");
  const ct = Buffer.from(enc.ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export async function encryptSecretEnvelope(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  masterKey: string;
  payload: unknown;
}) {
  const pk = await initPartitionKey({ pool: params.pool, tenantId: params.tenantId, scopeType: params.scopeType, scopeId: params.scopeId, masterKey: params.masterKey });
  const keyBytes = decryptPartitionKeyMaterial({ masterKey: params.masterKey, encryptedKey: pk.encryptedKey });
  const dek = crypto.randomBytes(32);
  const payloadBytes = Buffer.from(JSON.stringify(params.payload), "utf8");
  const wrappedDek = encryptBytes(keyBytes, dek);
  const payloadEnc = encryptBytes(dek, payloadBytes);
  const env: EnvelopeV1 = { format: "envelope.v1", keyRef: { scopeType: params.scopeType, scopeId: params.scopeId, keyVersion: pk.keyVersion }, payload: payloadEnc, wrappedDek };
  return { encFormat: "envelope.v1", keyVersion: pk.keyVersion, keyRef: env.keyRef, encryptedPayload: env };
}

export async function decryptSecretPayload(params: {
  pool: Pool | PoolClient;
  tenantId: string;
  masterKey: string;
  scopeType: string;
  scopeId: string;
  keyVersion: number;
  encFormat: string;
  encryptedPayload: any;
}) {
  if (params.encFormat !== "envelope.v1") {
    return decryptJson(params.masterKey, params.encryptedPayload as EncryptedPayload);
  }
  const env = params.encryptedPayload as EnvelopeV1;
  const key = await getPartitionKey({ pool: params.pool, tenantId: params.tenantId, scopeType: params.scopeType, scopeId: params.scopeId, keyVersion: params.keyVersion });
  if (!key) throw new Error("key_not_found");
  if (key.status === "disabled") throw new Error("key_disabled");
  const keyBytes = decryptPartitionKeyMaterial({ masterKey: params.masterKey, encryptedKey: key.encryptedKey });
  const dek = decryptBytes(keyBytes, env.wrappedDek);
  const plain = decryptBytes(dek, env.payload);
  return JSON.parse(plain.toString("utf8"));
}
