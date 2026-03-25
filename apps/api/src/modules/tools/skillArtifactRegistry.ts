import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import unzipper from "unzipper";
import crypto from "node:crypto";
import { computeDepsDigest, loadSkillManifest, verifySkillManifestTrustWithKeys } from "./skillPackage";

export type SkillArtifactUploadResult = {
  depsDigest: string;
  manifestSummary: any;
  signatureStatus: "trusted" | "untrusted" | "bypassed";
  scanSummary: any;
  sbomSummary: any;
  sbomDigest: string | null;
};

function registryRootDir() {
  const raw = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  return path.resolve(raw || path.resolve(process.cwd(), ".data", "skill-registry"));
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function dependencyScanMode() {
  const raw = String(process.env.SKILL_DEP_SCAN_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off" as const;
  if (raw === "audit_only") return "audit_only" as const;
  if (raw === "deny") return "deny" as const;
  return process.env.NODE_ENV === "production" ? ("deny" as const) : ("audit_only" as const);
}

async function exists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function stableValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableValue(v[k]);
  return out;
}

function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

function parsePkgNameFromLockPath(p: string) {
  const s = String(p ?? "");
  if (!s.startsWith("node_modules/")) return null;
  const rest = s.slice("node_modules/".length);
  if (!rest) return null;
  const parts = rest.split("/");
  if (!parts.length) return null;
  if (parts[0]!.startsWith("@")) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

export async function computeSkillSbomV1(params: { artifactDir: string; depsDigest: string; manifestSummary: any }) {
  const lockPath = (await exists(path.join(params.artifactDir, "package-lock.json")))
    ? path.join(params.artifactDir, "package-lock.json")
    : (await exists(path.join(params.artifactDir, "npm-shrinkwrap.json")))
      ? path.join(params.artifactDir, "npm-shrinkwrap.json")
      : null;
  const pkgPath = (await exists(path.join(params.artifactDir, "package.json"))) ? path.join(params.artifactDir, "package.json") : null;
  const manifestPath = (await exists(path.join(params.artifactDir, "manifest.json"))) ? path.join(params.artifactDir, "manifest.json") : null;
  if (!lockPath) {
    return { sbomSummary: { format: "sbom.v1", status: "skipped", reason: "no_lockfile", components: [] }, sbomDigest: null };
  }
  const lockRaw = await fs.readFile(lockPath, "utf8");
  let lock: any = null;
  try {
    lock = JSON.parse(lockRaw);
  } catch {
    return { sbomSummary: { format: "sbom.v1", status: "error", reason: "bad_lockfile", components: [] }, sbomDigest: null };
  }
  const pkgs = lock && typeof lock === "object" && !Array.isArray(lock) ? (lock as any).packages : null;
  const components: any[] = [];
  const seen = new Set<string>();
  if (pkgs && typeof pkgs === "object" && !Array.isArray(pkgs)) {
    for (const [k, v] of Object.entries<any>(pkgs)) {
      const name = parsePkgNameFromLockPath(String(k));
      if (!name) continue;
      if (seen.has(name)) continue;
      const version = typeof v?.version === "string" ? v.version : undefined;
      components.push({ name, version, type: "npm" });
      seen.add(name);
      if (components.length >= 500) break;
    }
  }
  components.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const artifactFilesDigestInput = [
    manifestPath ? await fs.readFile(manifestPath, "utf8").catch(() => "") : "",
    pkgPath ? await fs.readFile(pkgPath, "utf8").catch(() => "") : "",
    lockRaw,
  ].join("\n");
  const artifactFilesDigest = { sha256_8: sha256_8(artifactFilesDigestInput), count: [manifestPath, pkgPath, lockPath].filter(Boolean).length };
  const buildProvenanceDigest = { sha256_8: sha256_8(JSON.stringify(stableValue({ depsDigest: params.depsDigest, manifest: params.manifestSummary ?? null }))) };
  const sbomSummary = { format: "sbom.v1", status: "ok", components, artifactFilesDigest, buildProvenanceDigest };
  const sbomDigest = `sha256:${crypto.createHash("sha256").update(JSON.stringify(stableValue(sbomSummary)), "utf8").digest("hex")}`;
  return { sbomSummary, sbomDigest };
}

export async function scanSkillDependencies(params: { artifactDir: string }) {
  const mode = dependencyScanMode();
  if (mode === "off") return { mode, status: "skipped" as const, reason: "scan_off", scannedAt: new Date().toISOString() };

  const fake = String(process.env.SKILL_DEP_SCAN_FAKE_JSON ?? "").trim();
  if (fake) {
    try {
      const parsed = JSON.parse(fake);
      return { mode, scannedAt: new Date().toISOString(), ...parsed };
    } catch {
      return { mode, status: "error" as const, reason: "bad_fake_json", scannedAt: new Date().toISOString() };
    }
  }

  const lock = (await exists(path.join(params.artifactDir, "package-lock.json")))
    ? "package-lock.json"
    : (await exists(path.join(params.artifactDir, "npm-shrinkwrap.json")))
      ? "npm-shrinkwrap.json"
      : null;
  const hasPkg = await exists(path.join(params.artifactDir, "package.json"));
  if (!lock) {
    return {
      mode,
      status: "skipped" as const,
      reason: hasPkg ? "no_lockfile" : "no_package_json",
      scannedAt: new Date().toISOString(),
    };
  }

  const startedAt = Date.now();
  const proc = child_process.spawnSync("npm", ["audit", "--json", "--omit=dev"], {
    cwd: params.artifactDir,
    encoding: "utf8",
    timeout: 12_000,
    windowsHide: true,
  });
  const finishedAt = Date.now();
  const output = String(proc.stdout || proc.stderr || "");
  if (proc.error) {
    return { mode, status: "error" as const, reason: String(proc.error.message || proc.error), lockfile: lock, scannedAt: new Date().toISOString(), durationMs: finishedAt - startedAt };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { mode, status: "error" as const, reason: "bad_audit_output", lockfile: lock, scannedAt: new Date().toISOString(), durationMs: finishedAt - startedAt };
  }
  const meta = parsed?.metadata?.vulnerabilities ?? parsed?.metadata?.advisories ?? null;
  const vulns = parsed?.metadata?.vulnerabilities ?? null;
  const counts = vulns && typeof vulns === "object" ? vulns : {};
  const summary = {
    mode,
    status: "ok" as const,
    scanner: "npm_audit",
    lockfile: lock,
    scannedAt: new Date().toISOString(),
    durationMs: finishedAt - startedAt,
    vulnerabilities: {
      critical: Number(counts.critical ?? 0) || 0,
      high: Number(counts.high ?? 0) || 0,
      moderate: Number(counts.moderate ?? 0) || 0,
      low: Number(counts.low ?? 0) || 0,
    },
  };
  void meta;
  return summary;
}

async function extractZip(buffer: Buffer, destDir: string) {
  await ensureDir(destDir);
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.from(buffer);
    stream.pipe(unzipper.Extract({ path: destDir })).on("close", resolve).on("error", reject);
  });
}

async function extractTgz(buffer: Buffer, destDir: string) {
  await ensureDir(destDir);
  const tmp = path.join(destDir, ".upload.tgz");
  await fs.writeFile(tmp, buffer);
  try {
    await tar.x({ file: tmp, cwd: destDir, gzip: true });
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function normalizeSkillArtifactRoot(destDir: string) {
  try {
    await fs.stat(path.join(destDir, "manifest.json"));
    return destDir;
  } catch {}

  const entries = await fs.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length !== 1) throw new Error("policy_violation:manifest_not_found");
  const innerDir = path.join(destDir, dirs[0]!);
  await fs.stat(path.join(innerDir, "manifest.json"));
  const innerEntries = await fs.readdir(innerDir, { withFileTypes: true });
  for (const e of innerEntries) {
    await fs.rename(path.join(innerDir, e.name), path.join(destDir, e.name));
  }
  await fs.rm(innerDir, { recursive: true, force: true });
  return destDir;
}

export async function materializeSkillArtifact(params: { artifactId: string; archiveFormat: "zip" | "tgz"; archiveBytes: Buffer }) {
  const root = registryRootDir();
  const destDir = path.join(root, params.artifactId);
  await ensureDir(root);
  await fs.rm(destDir, { recursive: true, force: true });
  await ensureDir(destDir);
  if (params.archiveFormat === "zip") await extractZip(params.archiveBytes, destDir);
  else await extractTgz(params.archiveBytes, destDir);
  await normalizeSkillArtifactRoot(destDir);
  return destDir;
}

export function resolveSkillArtifactDir(artifactId: string) {
  return path.join(registryRootDir(), artifactId);
}

export async function inspectSkillArtifactDir(params: { artifactDir: string; trustedKeys?: Map<string, crypto.KeyObject> }) : Promise<SkillArtifactUploadResult> {
  const loaded = await loadSkillManifest(params.artifactDir);
  const name = String(loaded.manifest?.identity?.name ?? "");
  if (!name) throw new Error("policy_violation:manifest_missing_name");
  const depsDigest = await computeDepsDigest({ artifactDir: params.artifactDir, manifest: loaded.manifest });
  const trust = verifySkillManifestTrustWithKeys({ toolName: name, depsDigest, manifest: loaded.manifest, trustedKeys: params.trustedKeys ?? new Map() });
  if (trust.status === "untrusted") throw new Error(`policy_violation:skill_untrusted:${trust.reason ?? "untrusted"}`);
  const scanSummary = await scanSkillDependencies({ artifactDir: params.artifactDir });
  const scanMode = String((scanSummary as any)?.mode ?? "").toLowerCase();
  const scanStatus = String((scanSummary as any)?.status ?? "").toLowerCase();
  const vulns = (scanSummary as any)?.vulnerabilities ?? null;
  const crit = Number((vulns as any)?.critical ?? 0) || 0;
  const high = Number((vulns as any)?.high ?? 0) || 0;
  if (scanMode === "deny") {
    if (scanStatus === "error") throw new Error("policy_violation:skill_dep_scan_failed");
    if (scanStatus === "ok" && (crit > 0 || high > 0)) throw new Error("policy_violation:skill_dep_scan_denied");
  }
  const manifestSummary = {
    identity: loaded.manifest?.identity ?? null,
    contract: loaded.manifest?.contract ?? null,
    entry: loaded.manifest?.entry ?? null,
    io: loaded.manifest?.io ?? null,
    signature: loaded.manifest?.signature ? { alg: loaded.manifest.signature.alg, keyId: loaded.manifest.signature.keyId, signedDigest: loaded.manifest.signature.signedDigest } : null,
  };
  const sbom = await computeSkillSbomV1({ artifactDir: params.artifactDir, depsDigest, manifestSummary });
  return { depsDigest, manifestSummary, signatureStatus: trust.status, scanSummary, sbomSummary: sbom.sbomSummary, sbomDigest: sbom.sbomDigest };
}
