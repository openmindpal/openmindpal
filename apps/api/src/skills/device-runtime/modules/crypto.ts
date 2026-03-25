import crypto from "node:crypto";

export function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function randomCode(prefix: string) {
  return `${prefix}${crypto.randomBytes(24).toString("base64url")}`;
}

