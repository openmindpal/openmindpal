import { digestObject, sha256Hex, stableStringify } from "./common";

function shallowOmit(obj: any, omit: string[]) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (omit.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function computeSealedDigestV1(v: any) {
  const normalized = shallowOmit(v, ["latencyMs"]);
  const s = stableStringify(normalized);
  return { len: Buffer.byteLength(s, "utf8"), sha256_8: sha256Hex(s).slice(0, 8) };
}

export function deriveIsolation(runtimeBackend: any, degraded: boolean) {
  const rb = String(runtimeBackend ?? "");
  const level = rb.includes("remote") ? "remote" : rb.includes("container") ? "container" : "process";
  const enforced = !degraded;
  return { level, enforced };
}

export function computeEvidenceDigestV1(v: any) {
  const evidence = Array.isArray(v?.evidence) ? v.evidence : [];
  const normalized = evidence.map((e: any) => ({
    retrievalLogId: typeof e?.retrievalLogId === "string" ? e.retrievalLogId : null,
    sourceRef: e?.sourceRef ?? null,
    snippetDigest: e?.snippetDigest ?? null,
    location: e?.location ?? null,
    rankReason: e?.rankReason ?? null,
  }));
  return { evidenceCount: evidence.length, evidenceDigest: computeSealedDigestV1({ evidence: normalized }), evidenceKeys: digestObject({ evidence: normalized }) };
}
