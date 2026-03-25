import crypto from "node:crypto";

function stable(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stable(v[k]);
  return out;
}

export function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function digestParams(params: any) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return { keyCount: 0, keys: [], sha256_8: sha256Hex("null").slice(0, 8) };
  const keys = Object.keys(params).slice(0, 50);
  const h = sha256Hex(JSON.stringify(stable(params)));
  return { keyCount: Object.keys(params).length, keys, sha256_8: h.slice(0, 8) };
}

const OMIT_KEYS = new Set(["traceId", "trace_id", "requestId", "request_id", "idempotencyKey", "idempotency_key"]);

function sanitizeForDigest(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sanitizeForDigest);
  const out: any = {};
  for (const k of Object.keys(v)) {
    if (OMIT_KEYS.has(k)) continue;
    out[k] = sanitizeForDigest(v[k]);
  }
  return out;
}

export function digestInputV1(input: any) {
  return digestParams(sanitizeForDigest(input));
}
