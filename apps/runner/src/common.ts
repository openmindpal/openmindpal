import crypto from "node:crypto";

function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

export function stableStringify(v: any): string {
  return JSON.stringify(stableStringifyValue(v));
}

export function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function jsonByteLength(v: unknown) {
  try {
    const s = JSON.stringify(v);
    return Buffer.byteLength(s, "utf8");
  } catch {
    return 0;
  }
}

