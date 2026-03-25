import crypto from "node:crypto";

export function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

export function safeLog(message: string) {
  process.stdout.write(message + "\n");
}

export function safeError(message: string) {
  process.stderr.write(message + "\n");
}

