import crypto from "node:crypto";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressEvent, NetworkPolicy } from "./runtime";
import { stableStringify } from "./common";

function getSkillRoots() {
  const raw = String(process.env.SKILL_PACKAGE_ROOTS ?? "");
  const parts = raw
    .split(/[;,]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const reg = String(process.env.SKILL_REGISTRY_DIR ?? "").trim();
  const registryRoot = path.resolve(reg || path.resolve(process.cwd(), ".data", "skill-registry"));
  if (parts.length) return Array.from(new Set([...parts.map((p) => path.resolve(p)), registryRoot]));
  return [path.resolve(process.cwd(), "skills"), registryRoot];
}

function isWithinRoot(root: string, target: string) {
  const sep = path.sep;
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  const r2 = r.endsWith(sep) ? r : `${r}${sep}`;
  return t === r || t.startsWith(r2);
}

function resolveArtifactDir(artifactRef: string) {
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
  return path.resolve(process.cwd(), trimmed);
}

async function loadManifest(artifactDir: string) {
  const p = path.join(artifactDir, "manifest.json");
  const raw = await fs.readFile(p, "utf8");
  const manifest = JSON.parse(raw);
  return { manifest, raw };
}

async function computeDepsDigest(params: { artifactDir: string; manifest: any }) {
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

async function resolveSandboxChildEntry() {
  const jsPath = path.resolve(__dirname, "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) return { entry: jsPath, execArgv: [] as string[] };
  } catch {}
  const tsPath = path.resolve(__dirname, "skillSandboxChild.ts");
  return { entry: tsPath, execArgv: ["-r", "tsx/cjs"] as string[] };
}

export async function executeSkillInSandbox(params: {
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: any;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  expectedDepsDigest: string | null;
  signal: AbortSignal;
}): Promise<{ output: any; egress: EgressEvent[]; depsDigest: string }> {
  const artifactDir = resolveArtifactDir(params.artifactRef);
  const roots = getSkillRoots();
  if (!roots.some((r) => isWithinRoot(r, artifactDir))) throw new Error("policy_violation:artifact_outside_roots");
  const loaded = await loadManifest(artifactDir);
  const depsDigest = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
  if (params.expectedDepsDigest && depsDigest !== params.expectedDepsDigest) throw new Error("policy_violation:deps_digest_mismatch");
  const entryRel = String(loaded.manifest?.entry ?? "");
  if (!entryRel) throw new Error("policy_violation:skill_manifest_missing_entry");
  const entryPath = path.resolve(artifactDir, entryRel);
  if (!isWithinRoot(artifactDir, entryPath)) throw new Error("policy_violation:skill_entry_outside_artifact");
  const childInfo = await resolveSandboxChildEntry();
  const memArgv =
    typeof params.limits?.memoryMb === "number" && Number.isFinite(params.limits.memoryMb) && params.limits.memoryMb > 0
      ? [`--max-old-space-size=${Math.max(32, Math.round(params.limits.memoryMb))}`]
      : [];
  const child = child_process.fork(childInfo.entry, [], { execArgv: [...childInfo.execArgv, ...memArgv], stdio: ["ignore", "ignore", "ignore", "ipc"] });

  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const cpuTimeLimitMs =
    typeof params.limits?.cpuTimeLimitMs === "number" && Number.isFinite(params.limits.cpuTimeLimitMs) && params.limits.cpuTimeLimitMs > 0
      ? Math.max(1, Math.floor(params.limits.cpuTimeLimitMs))
      : null;

  const result = await new Promise<any>((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`skill_sandbox_exited:${code ?? "null"}`));
    const onMessage = (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.type !== "result") return;
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(m);
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
    child.send({
      type: "execute",
      payload: {
        toolRef: params.toolRef,
        tenantId: params.tenantId,
        spaceId: params.spaceId,
        subjectId: params.subjectId,
        traceId: params.traceId,
        idempotencyKey: params.idempotencyKey,
        input: params.input,
        limits: params.limits,
        cpuTimeLimitMs,
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest,
        entryPath,
      },
    });
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    kill();
  });

  if (!result?.ok) {
    const msg = String(result?.error?.message ?? "skill_sandbox_error");
    const e: any = new Error(msg);
    e.egress = Array.isArray(result.egress) ? result.egress : [];
    throw e;
  }
  return { output: result.output, egress: Array.isArray(result.egress) ? result.egress : [], depsDigest: String(result.depsDigest ?? depsDigest) };
}
