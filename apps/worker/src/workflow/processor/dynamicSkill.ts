import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { type CapabilityEnvelopeV1, resolveSupplyChainPolicy } from "@openslin/shared";
import type { EgressEvent, NetworkPolicy, RuntimeLimits } from "./runtime";
import { isAllowedEgress } from "./runtime";
import { parseToolRef } from "./tooling";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";
import { getSkillRoots, isWithinRoot, resolveArtifactDir, loadManifest, computeDepsDigest, pickExecute, loadTrustedSkillKeys, verifySkillManifestTrust } from "./dynamicSkillArtifact";
import { getSkillRuntimeBackendPref, loadRemoteRunnerConfig, allowSkillRuntimeContainerFallback } from "./dynamicSkillConfig";
import { executeDynamicSkillSandboxed } from "./dynamicSkillSandbox";
import { executeDynamicSkillContainered } from "./dynamicSkillContainer";
import { executeDynamicSkillRemote } from "./dynamicSkillRemote";

export { executeDynamicSkillRemote } from "./dynamicSkillRemote";
export type { DynamicSkillExecResult } from "./dynamicSkillTypes";

export async function executeDynamicSkill(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  masterKey: string;
  capabilityEnvelope: CapabilityEnvelopeV1 | null;
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
  depsDigest: string | null;
  egress: EgressEvent[];
  signal: AbortSignal;
}): Promise<{ output: any; depsDigest: string; runtimeBackend: DynamicSkillExecResult["runtimeBackend"]; degraded: boolean; runnerSummary: any | null }> {
  const policy = resolveSupplyChainPolicy();
  const unsafeAllowed = policy.unsafeAllowed;
  const minIsolation = policy.minIsolation;

  const roots = getSkillRoots();
  const artifactDir = resolveArtifactDir(params.artifactRef);
  if (!roots.some((r) => isWithinRoot(r, artifactDir))) throw new Error("policy_violation:artifact_outside_allowlist");

  const loaded = await loadManifest(artifactDir);
  const name = String(loaded.manifest?.identity?.name ?? "");
  if (!name || name !== parseToolRef(params.toolRef)?.name) throw new Error("policy_violation:manifest_name_mismatch");

  const computed = await computeDepsDigest({ artifactDir, manifest: loaded.manifest });
  if (params.depsDigest && params.depsDigest !== computed) throw new Error("policy_violation:deps_digest_mismatch");

  const trustedKeys = await loadTrustedSkillKeys({ pool: params.pool, tenantId: params.tenantId });
  verifySkillManifestTrust({ toolName: name, depsDigest: computed, manifest: loaded.manifest, unsafeBypass: unsafeAllowed, trustedKeys });

  const entryRel = String(loaded.manifest?.entry ?? "");
  if (!entryRel) throw new Error("policy_violation:manifest_missing_entry");
  const entryPath = path.resolve(artifactDir, entryRel);
  const entryText = await fs.readFile(entryPath, "utf8");
  const forbidden = [
    "node:child_process",
    "child_process",
    "node:net",
    "net",
    "node:tls",
    "tls",
    "node:dns",
    "dns",
    "node:http",
    "http",
    "node:https",
    "https",
    "node:dgram",
    "dgram",
    "node:fs",
    "fs",
    "node:fs/promises",
    "fs/promises",
    "node:worker_threads",
    "worker_threads",
    "node:vm",
    "vm",
    "pg",
    "mysql",
    "mysql2",
    "sqlite3",
    "better-sqlite3",
    "mongodb",
    "oracledb",
    "mssql",
    "redis",
    "ioredis",
  ];
  for (const modName of forbidden) {
    const base = modName.startsWith("node:") ? modName.slice("node:".length) : modName;
    const hits =
      entryText.includes(`"${modName}"`) ||
      entryText.includes(`'${modName}'`) ||
      entryText.includes(`"${base}"`) ||
      entryText.includes(`'${base}'`) ||
      entryText.includes(`require("${modName}")`) ||
      entryText.includes(`require('${modName}')`) ||
      entryText.includes(`require("${base}")`) ||
      entryText.includes(`require('${base}')`) ||
      entryText.includes(`from "${modName}"`) ||
      entryText.includes(`from '${modName}'`) ||
      entryText.includes(`from "${base}"`) ||
      entryText.includes(`from '${base}'`);
    if (hits) throw new Error(`policy_violation:skill_forbidden_import:${base}`);
  }

  let res: DynamicSkillExecResult | null = null;
  const pref = getSkillRuntimeBackendPref();
  try {
    const allowFallback = allowSkillRuntimeContainerFallback();
    const wantRemote = pref === "remote" || pref === "auto";
    const wantContainer = pref === "container" || pref === "auto";
    let executed = false;

    if (wantRemote) {
      const remote = await loadRemoteRunnerConfig({ pool: params.pool, tenantId: params.tenantId, masterKey: params.masterKey });
      if (remote) {
        try {
          if (!params.capabilityEnvelope) throw new Error("policy_violation:capability_envelope_missing");
          res = await executeDynamicSkillRemote({
            endpoint: remote.endpoint,
            bearerToken: remote.bearerToken,
            jobId: params.jobId,
            runId: params.runId,
            stepId: params.stepId,
            requestId: crypto.randomUUID(),
            toolRef: params.toolRef,
            tenantId: params.tenantId,
            spaceId: params.spaceId,
            subjectId: params.subjectId,
            traceId: params.traceId,
            idempotencyKey: params.idempotencyKey,
            input: params.input,
            limits: params.limits,
            networkPolicy: params.networkPolicy,
            capabilityEnvelope: params.capabilityEnvelope,
            artifactRef: params.artifactRef,
            depsDigest: computed,
            trustedKeys,
            signal: params.signal,
          });
          executed = true;
        } catch (e) {
          if (pref === "remote") throw e;
        }
      } else if (pref === "remote") {
        throw new Error("policy_violation:remote_runtime_not_configured");
      }
    }
    if (minIsolation === "remote" && !executed) {
      throw new Error("policy_violation:isolation_required");
    }

    if (!executed && wantContainer) {
      try {
        res = await executeDynamicSkillContainered({
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
          depsDigest: computed,
          entryPath,
          artifactDir,
          signal: params.signal,
        });
      } catch (e) {
        if (!allowFallback) throw e;
        if (minIsolation === "container") throw new Error("policy_violation:isolation_required");
        const tmp = await executeDynamicSkillSandboxed({
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
          depsDigest: computed,
          entryPath,
          signal: params.signal,
        });
        res = { ...tmp, runtimeBackend: "process", degraded: true };
      }
      executed = true;
    }

    if (!executed) {
      if (minIsolation === "container") throw new Error("policy_violation:isolation_required");
      res = await executeDynamicSkillSandboxed({
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
        depsDigest: computed,
        entryPath,
        signal: params.signal,
      });
    }
  } catch (e) {
    if (pref === "remote") throw e;
    if (process.env.NODE_ENV === "production") throw e;
    if (minIsolation !== "process") throw e;
    const localEgress: EgressEvent[] = [];
    const originalFetch = globalThis.fetch;
    const wrappedFetch = async (input: any, init?: any) => {
      const maxEgressRequests =
        typeof params.limits.maxEgressRequests === "number" && Number.isFinite(params.limits.maxEgressRequests)
          ? Math.max(0, Math.round(params.limits.maxEgressRequests))
          : null;
      if (maxEgressRequests !== null && localEgress.length >= maxEgressRequests) {
        throw new Error("resource_exhausted:max_egress_requests");
      }
      const url = typeof input === "string" ? input : input?.url ? String(input.url) : "";
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      const chk = isAllowedEgress({ policy: params.networkPolicy, url, method });
      if (!chk.allowed) {
        localEgress.push({ host: chk.host, method: chk.method, allowed: false, errorCategory: "policy_violation" });
        throw new Error(chk.reason ?? "policy_violation:egress_denied");
      }
      const resp = await originalFetch(input as any, init as any);
      localEgress.push({ host: chk.host, method: chk.method, allowed: true, policyMatch: chk.match, status: (resp as any)?.status });
      return resp;
    };

    try {
      if (typeof originalFetch === "function") globalThis.fetch = wrappedFetch as any;
      const mod = await import(pathToFileURL(entryPath).href);
      const exec = pickExecute(mod);
      if (!exec) throw new Error("policy_violation:skill_missing_execute");
      const output = await exec({
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
        depsDigest: computed,
      });
      res = { output, egress: localEgress, depsDigest: computed, runtimeBackend: "local", degraded: true };
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  }
  if (!res) throw new Error("internal:dynamic_skill_no_result");
  for (const ev of res.egress) params.egress.push(ev);
  return { output: res.output, depsDigest: computed, runtimeBackend: res.runtimeBackend, degraded: res.degraded, runnerSummary: res.runnerSummary ?? null };
}
