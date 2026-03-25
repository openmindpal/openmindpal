import crypto from "node:crypto";

function deriveKey(masterKey: string) {
  return crypto.createHash("sha256").update(masterKey, "utf8").digest();
}

export type EncryptedPayload = {
  alg: "A256GCM";
  iv: string;
  tag: string;
  ct: string;
};

export function encryptJson(masterKey: string, payload: unknown): EncryptedPayload {
  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptJson(masterKey: string, encrypted: EncryptedPayload): unknown {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(encrypted.iv, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ct = Buffer.from(encrypted.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
