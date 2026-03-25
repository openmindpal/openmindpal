import { apiGetJson, apiPostJson } from "./api";
import type { DeviceAgentConfig } from "./config";
import { safeError, safeLog, sha256_8 } from "./log";
import { executeDeviceTool } from "./executors";
import { disposeAllPlugins } from "./pluginRegistry";

export type DeviceExecution = {
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
};

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  if (idx <= 0) return toolRef;
  return toolRef.slice(0, idx);
}

function digestObject(v: any) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  return { keyCount: keys.length, keys: keys.slice(0, 50) };
}

function mergeOutputDigest(base: any, extra: any) {
  const a = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const b = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  return { ...a, ...b };
}

export async function runOnce(params: {
  cfg: DeviceAgentConfig;
  confirmFn: (q: string) => Promise<boolean>;
  now: () => Date;
}) {
  const pending = await apiGetJson<{ executions: DeviceExecution[] }>({ apiBase: params.cfg.apiBase, path: "/device-agent/executions/pending?limit=10", token: params.cfg.deviceToken });
  if (pending.status === 401 || pending.status === 403) return { ok: false, needReEnroll: true as const };
  if (pending.status !== 200) return { ok: false, needReEnroll: false as const };

  const list = Array.isArray(pending.json?.executions) ? pending.json.executions : [];
  for (const e of list) {
    const claim = await apiPostJson<{ execution: DeviceExecution; requireUserPresence?: boolean; policy?: any }>({
      apiBase: params.cfg.apiBase,
      path: `/device-agent/executions/${encodeURIComponent(e.deviceExecutionId)}/claim`,
      token: params.cfg.deviceToken,
      body: {},
    });
    if (claim.status === 401 || claim.status === 403) return { ok: false, needReEnroll: true as const };
    if (claim.status !== 200) continue;

    const name = toolName(e.toolRef);
    let status: "succeeded" | "failed" = "succeeded";
    let errorCategory: string | undefined;
    let outputDigest: any = null;
    let evidenceRefs: string[] | undefined;
    try {
      const out = await executeDeviceTool({ cfg: params.cfg, claim: claim.json as any, confirmFn: params.confirmFn });
      status = out.status;
      errorCategory = out.errorCategory;
      outputDigest = out.outputDigest ?? null;
      evidenceRefs = Array.isArray((out as any).evidenceRefs) ? ((out as any).evidenceRefs as string[]) : undefined;
    } catch (err: any) {
      status = "failed";
      errorCategory = "executor_error";
      outputDigest = { messageLen: String(err?.message ?? "unknown").length };
    }

    const policyDigest = (claim.json as any)?.policyDigest ?? null;
    outputDigest = mergeOutputDigest(outputDigest, policyDigest ? { policyDigest } : null);
    outputDigest = mergeOutputDigest(outputDigest, { tool: name, inputDigest: digestObject(exec.input ?? null) });

    const result = await apiPostJson({
      apiBase: params.cfg.apiBase,
      path: `/device-agent/executions/${encodeURIComponent(e.deviceExecutionId)}/result`,
      token: params.cfg.deviceToken,
      body: { status, errorCategory, outputDigest, evidenceRefs: status === "succeeded" ? (evidenceRefs ?? [`local:evidence:${sha256_8(e.deviceExecutionId)}`]) : undefined },
    });
    if (result.status === 401 || result.status === 403) return { ok: false, needReEnroll: true as const };
  }

  return { ok: true, needReEnroll: false as const };
}

export async function heartbeatOnce(params: { cfg: DeviceAgentConfig }) {
  const r = await apiPostJson<{ ok: boolean }>({
    apiBase: params.cfg.apiBase,
    path: "/device-agent/heartbeat",
    token: params.cfg.deviceToken,
    body: { os: params.cfg.os, agentVersion: params.cfg.agentVersion },
  });
  if (r.status === 401 || r.status === 403) return { ok: false, needReEnroll: true as const };
  return { ok: r.status === 200, needReEnroll: false as const };
}

export async function runLoop(params: {
  cfg: DeviceAgentConfig;
  confirmFn: (q: string) => Promise<boolean>;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  onLog?: (s: string) => void;
}) {
  const log = params.onLog ?? safeLog;
  const err = safeError;

  log(`device-agent running: deviceId=${params.cfg.deviceId} tokenSha256_8=${sha256_8(params.cfg.deviceToken)}`);

  let stopped = false;
  const stop = () => {
    stopped = true;
  };

  const heartbeatTimer = setInterval(async () => {
    if (stopped) return;
    const hb = await heartbeatOnce({ cfg: params.cfg });
    if (hb.needReEnroll) {
      err("device-agent unauthorized: need re-enroll");
      stop();
    }
  }, params.heartbeatIntervalMs);

  while (!stopped) {
    const r = await runOnce({ cfg: params.cfg, confirmFn: params.confirmFn, now: () => new Date() });
    if (!r.ok && r.needReEnroll) stop();
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }

  clearInterval(heartbeatTimer);

  // Graceful plugin shutdown — invoke dispose() on all registered plugins
  try {
    await disposeAllPlugins();
  } catch (e: any) {
    err(`device-agent disposeAllPlugins error: ${e?.message ?? "unknown"}`);
  }
}
