import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { resolveSupplyChainPolicy } from "@openslin/shared";
import { stableStringify } from "./common";

export function getSkillRoots() {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw
    .split(/[;,]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
  if (parts.length) return Array.from(new Set([...parts.map((p) => path.resolve(p)), registryRoot]));
  const defaults = [path.resolve(process.cwd(), "skills"), path.resolve(process.cwd(), "..", "..", "skills")];
  const roots = defaults.filter((p) => existsSync(p));
  const base = roots.length ? roots : [defaults[0]];
  return Array.from(new Set([...base, registryRoot]));
}

export function isWithinRoot(root: string, target: string) {
  const sep = path.sep;
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  const r2 = r.endsWith(sep) ? r : `${r}${sep}`;
  return t === r || t.startsWith(r2);
}

export function resolveArtifactDir(artifactRef: string) {
  const trimmed = artifactRef.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) throw new Error("policy_violation:artifact_url_not_allowed");
  if (trimmed.startsWith("artifact:")) {
    const artifactId = trimmed.slice("artifact:".length).trim();
    if (!artifactId) throw new Error("policy_violation:artifact_ref_invalid");
    const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
    const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
    return path.resolve(registryRoot, artifactId);
  }
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  if (path.isAbsolute(trimmed)) return trimmed;
  const direct = path.resolve(process.cwd(), trimmed);
  if (existsSync(direct)) return direct;
  const up2 = path.resolve(process.cwd(), "..", "..", trimmed);
  if (existsSync(up2)) return up2;
  return direct;
}

export async function loadManifest(artifactDir: string) {
  const p = path.join(artifactDir, "manifest.json");
  const raw = await fs.readFile(p, "utf8");
  const manifest = JSON.parse(raw);
  return { manifest, raw };
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

export function pickExecute(mod: any) {
  if (mod && typeof mod.execute === "function") return mod.execute as (req: any) => Promise<any>;
  if (mod && mod.default && typeof mod.default.execute === "function") return mod.default.execute as (req: any) => Promise<any>;
  if (mod && typeof mod.default === "function") return mod.default as (req: any) => Promise<any>;
  return null;
}

export async function loadTrustedSkillKeys(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    "SELECT key_id, public_key_pem FROM skill_trusted_keys WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC",
    [params.tenantId],
  );
  const out = new Map<string, crypto.KeyObject>();
  for (const row of res.rows as any[]) {
    const keyId = String(row.key_id ?? "").trim();
    const pem = String(row.public_key_pem ?? "").trim();
    if (!keyId || !pem) continue;
    try {
      out.set(keyId, crypto.createPublicKey(pem));
    } catch {}
  }
  return out;
}

export function verifySkillManifestTrust(params: { toolName: string; depsDigest: string; manifest: any; unsafeBypass: boolean; trustedKeys: Map<string, crypto.KeyObject> }) {
  if (params.unsafeBypass) return;
  const enforce = resolveSupplyChainPolicy().trustEnforced;
  if (!enforce) return;

  const sig = params.manifest?.signature;
  const alg = String(sig?.alg ?? "").toLowerCase();
  const keyId = String(sig?.keyId ?? "");
  const sigBase64 = String(sig?.sigBase64 ?? "");
  const signedDigest = String(sig?.signedDigest ?? "");
  if (!alg || !keyId || !sigBase64 || !signedDigest) throw new Error("policy_violation:skill_untrusted:missing_signature");
  if (alg !== "ed25519") throw new Error("policy_violation:skill_untrusted:unsupported_alg");
  if (signedDigest !== params.depsDigest) throw new Error("policy_violation:skill_untrusted:signed_digest_mismatch");

  const pub = params.trustedKeys.get(keyId);
  if (!pub) throw new Error("policy_violation:skill_untrusted:unknown_key");

  const msg = `openslin:skill:${params.toolName}:${signedDigest}`;
  const ok = crypto.verify(null, Buffer.from(msg, "utf8"), pub, Buffer.from(sigBase64, "base64"));
  if (!ok) throw new Error("policy_violation:skill_untrusted:bad_signature");
}
