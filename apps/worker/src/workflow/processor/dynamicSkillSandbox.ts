import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";

async function resolveSandboxChildEntry() {
  const jsPath = path.resolve(__dirname, "..", "skillSandboxChild.js");
  try {
    const st = await fs.stat(jsPath);
    if (st.isFile()) return { entry: jsPath, execArgv: [] as string[] };
  } catch {}
  const tsPath = path.resolve(__dirname, "..", "skillSandboxChild.ts");
  return { entry: tsPath, execArgv: ["-r", "tsx/cjs"] as string[] };
}

export async function executeDynamicSkillSandboxed(params: {
  toolRef: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  idempotencyKey: string | null;
  input: any;
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  artifactRef: string;
  depsDigest: string;
  entryPath: string;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const childInfo = await resolveSandboxChildEntry();
  const memArgv =
    typeof params.limits.memoryMb === "number" && Number.isFinite(params.limits.memoryMb) && params.limits.memoryMb > 0
      ? [`--max-old-space-size=${Math.max(32, Math.round(params.limits.memoryMb))}`]
      : [];
  const child = child_process.fork(childInfo.entry, [], {
    execArgv: [...childInfo.execArgv, ...memArgv],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const result = await new Promise<any>((resolve, reject) => {
    const onExit = (code: number | null) => {
      const c = typeof code === "number" ? code : null;
      if (c === 134 || c === 137) {
        reject(new Error("resource_exhausted:memory"));
        return;
      }
      reject(new Error(`skill_sandbox_exited:${code ?? "null"}`));
    };
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
        networkPolicy: params.networkPolicy,
        artifactRef: params.artifactRef,
        depsDigest: params.depsDigest,
        entryPath: params.entryPath,
      },
    });
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    kill();
  });

  if (!result?.ok) {
    const msg = String(result?.error?.message ?? "skill_sandbox_error");
    throw new Error(msg);
  }
  return {
    output: result.output,
    egress: Array.isArray(result.egress) ? result.egress : [],
    depsDigest: String(result.depsDigest ?? params.depsDigest),
    runtimeBackend: "process",
    degraded: false,
  };
}
