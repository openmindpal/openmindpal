import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSupplyChainPolicy } from "@openslin/shared";

function stableStringify(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object" || Array.isArray(v)) return JSON.stringify(v);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue((v as any)[k]);
  return JSON.stringify(out);
}

function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

export function resolveArtifactDir(artifactRef: string) {
  const trimmed = artifactRef.trim();
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}

export async function loadSkillManifest(artifactDir: string) {
  const p = path.join(artifactDir, "manifest.json");
  const raw = await fs.readFile(p, "utf8");
  const manifest = JSON.parse(raw);
  return { path: p, raw, manifest };
}

export async function computeDepsDigest(params: { artifactDir: string; manifest: any }) {
  const manifestStable = stableStringify(params.manifest);
  const entryRel = String(params.manifest?.entry ?? "");
  const entryPath = entryRel ? path.resolve(params.artifactDir, entryRel) : "";
  const entryBytes = entryPath ? await fs.readFile(entryPath) : Buffer.from("");

  const h = crypto.createHash("sha256");
  h.update(Buffer.from(manifestStable, "utf8"));
  h.update(Buffer.from("\n", "utf8"));
  h.update(entryBytes);
  return `sha256:${h.digest("hex")}`;
}

function isTrustEnforced() {
  return resolveSupplyChainPolicy().trustEnforced;
}

function loadTrustedSkillKeys() {
  const raw = String(process.env.SKILL_TRUSTED_PUBKEYS_JSON ?? "").trim();
  if (!raw) {
    const pem = String(process.env.SKILL_TRUSTED_PUBKEY_PEM ?? "").trim();
    if (!pem) return new Map<string, crypto.KeyObject>();
    try {
      const key = crypto.createPublicKey(pem);
      return new Map<string, crypto.KeyObject>([["default", key]]);
    } catch {
      return new Map<string, crypto.KeyObject>();
    }
  }
  try {
    const obj = JSON.parse(raw);
    const out = new Map<string, crypto.KeyObject>();
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries<any>(obj)) {
        if (typeof k !== "string" || !k) continue;
        if (typeof v !== "string" || !v) continue;
        const keyText = v.includes("BEGIN") ? v : Buffer.from(v, "base64").toString("utf8");
        try {
          out.set(k, crypto.createPublicKey(keyText));
        } catch {}
      }
    }
    return out;
  } catch {
    return new Map<string, crypto.KeyObject>();
  }
}

export function verifySkillManifestTrust(params: { toolName: string; depsDigest: string; manifest: any }) {
  if (!isTrustEnforced()) return { status: "bypassed" as const };
  const sig = params.manifest?.signature;
  const alg = String(sig?.alg ?? "").toLowerCase();
  const keyId = String(sig?.keyId ?? "");
  const sigBase64 = String(sig?.sigBase64 ?? "");
  const signedDigest = String(sig?.signedDigest ?? "");
  if (!alg || !keyId || !sigBase64 || !signedDigest) return { status: "untrusted" as const, reason: "missing_signature" as const };
  if (alg !== "ed25519") return { status: "untrusted" as const, reason: "unsupported_alg" as const };
  if (signedDigest !== params.depsDigest) return { status: "untrusted" as const, reason: "signed_digest_mismatch" as const };

  const keys = loadTrustedSkillKeys();
  const pub = keys.get(keyId);
  if (!pub) return { status: "untrusted" as const, reason: "unknown_key" as const };

  const msg = `openslin:skill:${params.toolName}:${signedDigest}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sigBase64, "base64"));
  if (!ok) return { status: "untrusted" as const, reason: "bad_signature" as const };
  return { status: "trusted" as const };
}

export function parseTrustedSkillPublicKeys(params: { keyIdToPem: Record<string, string> }) {
  const out = new Map<string, crypto.KeyObject>();
  for (const [k, v] of Object.entries(params.keyIdToPem)) {
    if (!k || !v) continue;
    const keyText = v.includes("BEGIN") ? v : Buffer.from(v, "base64").toString("utf8");
    try {
      out.set(k, crypto.createPublicKey(keyText));
    } catch {}
  }
  return out;
}

export function verifySkillManifestTrustWithKeys(params: { toolName: string; depsDigest: string; manifest: any; trustedKeys: Map<string, crypto.KeyObject> }) {
  if (!isTrustEnforced()) return { status: "bypassed" as const };
  const sig = params.manifest?.signature;
  const alg = String(sig?.alg ?? "").toLowerCase();
  const keyId = String(sig?.keyId ?? "");
  const sigBase64 = String(sig?.sigBase64 ?? "");
  const signedDigest = String(sig?.signedDigest ?? "");
  if (!alg || !keyId || !sigBase64 || !signedDigest) return { status: "untrusted" as const, reason: "missing_signature" as const };
  if (alg !== "ed25519") return { status: "untrusted" as const, reason: "unsupported_alg" as const };
  if (signedDigest !== params.depsDigest) return { status: "untrusted" as const, reason: "signed_digest_mismatch" as const };

  const pub = params.trustedKeys.get(keyId);
  if (!pub) return { status: "untrusted" as const, reason: "unknown_key" as const };

  const msg = `openslin:skill:${params.toolName}:${signedDigest}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sigBase64, "base64"));
  if (!ok) return { status: "untrusted" as const, reason: "bad_signature" as const };
  return { status: "trusted" as const };
}

export function assertManifestConsistent(params: {
  toolName: string;
  expectedContract: { scope: string; resourceType: string; action: string; idempotencyRequired: boolean; riskLevel: string; approvalRequired: boolean };
  expectedSchemas: { inputSchema?: any; outputSchema?: any };
  manifest: any;
}) {
  const name = String(params.manifest?.identity?.name ?? "");
  if (name !== params.toolName) throw new Error("manifest.identity.name 不匹配");
  const entry = String(params.manifest?.entry ?? "");
  if (!entry) throw new Error("manifest.entry 缺失");

  const c = params.manifest?.contract ?? {};
  const exp = params.expectedContract;
  if (String(c.scope ?? "") !== exp.scope) throw new Error("manifest.contract.scope 不匹配");
  if (String(c.resourceType ?? "") !== exp.resourceType) throw new Error("manifest.contract.resourceType 不匹配");
  if (String(c.action ?? "") !== exp.action) throw new Error("manifest.contract.action 不匹配");
  if (Boolean(c.idempotencyRequired) !== Boolean(exp.idempotencyRequired)) throw new Error("manifest.contract.idempotencyRequired 不匹配");
  if (String(c.riskLevel ?? "") !== exp.riskLevel) throw new Error("manifest.contract.riskLevel 不匹配");
  if (Boolean(c.approvalRequired) !== Boolean(exp.approvalRequired)) throw new Error("manifest.contract.approvalRequired 不匹配");

  const io = params.manifest?.io ?? {};
  if (params.expectedSchemas.inputSchema !== undefined) {
    if (stableStringify(io.inputSchema ?? null) !== stableStringify(params.expectedSchemas.inputSchema ?? null)) throw new Error("manifest.io.inputSchema 不匹配");
  }
  if (params.expectedSchemas.outputSchema !== undefined) {
    if (stableStringify(io.outputSchema ?? null) !== stableStringify(params.expectedSchemas.outputSchema ?? null)) throw new Error("manifest.io.outputSchema 不匹配");
  }
}
