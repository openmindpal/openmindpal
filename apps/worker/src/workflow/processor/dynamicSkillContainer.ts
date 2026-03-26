import child_process from "node:child_process";
import type { RuntimeLimits, NetworkPolicy } from "./runtime";
import type { DynamicSkillExecResult } from "./dynamicSkillTypes";
import { getSkillRuntimeContainerImage, getSkillRuntimeContainerUser } from "./dynamicSkillConfig";

function buildContainerRunnerScript() {
  const js = `
    function pickExecute(mod){
      if(mod&&typeof mod.execute==='function') return mod.execute;
      if(mod&&mod.default&&typeof mod.default.execute==='function') return mod.default.execute;
      if(mod&&typeof mod.default==='function') return mod.default;
      return null;
    }
    function isAllowed(net, url, method){
      let u;
      try { u = new URL(url); } catch { return { allowed:false, host:'', method, reason:'policy_violation:egress_invalid_url' }; }
      const host = String(u.hostname||'').toLowerCase();
      const protocol = String(u.protocol||'');
      if (protocol !== 'http:' && protocol !== 'https:') return { allowed:false, host, method:String(method||'GET').toUpperCase(), reason:'policy_violation:egress_invalid_protocol:'+protocol.replace(':','') };
      const pathName = String(u.pathname||'/') || '/';
      const m = String(method||'GET').toUpperCase();
      const allowedDomains = net && Array.isArray(net.allowedDomains) ? net.allowedDomains : [];
      const byDomain = allowedDomains.some(d=>{
        const dl=String(d||'').toLowerCase();
        if(dl==='*')return true;
        if(dl.startsWith('*.')&&host.endsWith(dl.slice(1)))return true;
        return dl===host;
      });
      if (byDomain) return { allowed:true, host, method:m, reason:null, match:{ kind:'allowedDomain' } };
      const rules = net && Array.isArray(net.rules) ? net.rules : [];
      for (const r of rules) {
        if (!r || typeof r !== 'object') continue;
        const rh = String(r.host||'');
        if (!rh) continue;
        if (rh.toLowerCase() !== host.toLowerCase()) continue;
        const pp0 = r.pathPrefix ? String(r.pathPrefix) : '';
        const pp = pp0 ? (pp0.startsWith('/') ? pp0 : ('/' + pp0)) : '';
        if (pp && !pathName.startsWith(pp)) continue;
        const methods0 = Array.isArray(r.methods) ? r.methods.map(x=>String(x).trim().toUpperCase()).filter(Boolean) : null;
        if (methods0 && methods0.length && !methods0.includes(m)) continue;
        return { allowed:true, host, method:m, reason:null, match:{ kind:'rule', rulePathPrefix: pp || undefined, ruleMethods: methods0 || undefined } };
      }
      return { allowed:false, host, method:m, reason:'policy_violation:egress_denied:'+host };
    }
    let input='';
    process.stdin.on('data',c=>{ input+=c; });
    process.stdin.on('end', async ()=>{
      const payload = input ? JSON.parse(input) : {};
      const egress = [];
      const net = payload.networkPolicy || { allowedDomains: [] };
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch !== 'function') throw new Error('skill_sandbox_missing_fetch');
      globalThis.fetch = async (input0, init0)=>{
        const maxEgressRequests = payload && payload.limits && typeof payload.limits.maxEgressRequests === 'number' && Number.isFinite(payload.limits.maxEgressRequests) ? Math.max(0, Math.round(payload.limits.maxEgressRequests)) : null;
        if (maxEgressRequests !== null && egress.length >= maxEgressRequests) throw new Error('resource_exhausted:max_egress_requests');
        const url = typeof input0 === 'string' ? input0 : input0 && input0.url ? String(input0.url) : '';
        const method = String((init0&&init0.method) || (input0&&input0.method) || 'GET').toUpperCase();
        const chk = isAllowed(net, url, method);
        if (!chk.allowed) {
          egress.push({ host: chk.host, method: chk.method, allowed:false, errorCategory:'policy_violation' });
          throw new Error(chk.reason || 'policy_violation:egress_denied');
        }
        const res = await originalFetch(input0, init0);
        egress.push({ host: chk.host, method: chk.method, allowed:true, policyMatch: chk.match, status: res && res.status });
        return res;
      };
      try {
        let mod;
        try { mod = require(payload.entryPath); } catch { mod = await import('file://' + payload.entryPath); }
        const exec = pickExecute(mod);
        if (!exec) throw new Error('policy_violation:skill_missing_execute');
        const output = await exec({
          toolRef: payload.toolRef,
          tenantId: payload.tenantId,
          spaceId: payload.spaceId,
          subjectId: payload.subjectId,
          traceId: payload.traceId,
          idempotencyKey: payload.idempotencyKey,
          input: payload.input,
          limits: payload.limits,
          networkPolicy: payload.networkPolicy,
          artifactRef: payload.artifactRef,
          depsDigest: payload.depsDigest,
        });
        process.stdout.write(JSON.stringify({ type:'result', ok:true, output, egress, depsDigest: payload.depsDigest }));
      } catch(e) {
        const msg = String(e && e.message ? e.message : e);
        process.stdout.write(JSON.stringify({ type:'result', ok:false, error:{ message: msg }, egress, depsDigest: payload.depsDigest }));
      }
    });
  `;
  return js.replace(/\\s+/g, " ").trim();
}

export async function executeDynamicSkillContainered(params: {
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
  artifactDir: string;
  signal: AbortSignal;
}): Promise<DynamicSkillExecResult> {
  const image = getSkillRuntimeContainerImage();
  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-i",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "--user",
    getSkillRuntimeContainerUser(),
    "-v",
    `${params.artifactDir}:/skill:ro`,
    "-w",
    "/skill",
  ];
  if (typeof params.limits.memoryMb === "number" && Number.isFinite(params.limits.memoryMb) && params.limits.memoryMb > 0) {
    dockerArgs.push("--memory", `${Math.max(32, Math.round(params.limits.memoryMb))}m`);
  }
  if (typeof params.limits.cpuMs === "number" && Number.isFinite(params.limits.cpuMs) && params.limits.cpuMs > 0) {
    const cpus = Math.max(0.1, Math.min(8, params.limits.cpuMs / 1000));
    dockerArgs.push("--cpus", String(cpus));
  }
  dockerArgs.push(image, "node", "-e", buildContainerRunnerScript());

  const child = child_process.spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "ignore"] });
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  if (params.signal.aborted) kill();
  params.signal.addEventListener("abort", kill, { once: true });

  const payload = {
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
    entryPath: params.entryPath.replaceAll("\\\\", "/").replaceAll(params.artifactDir.replaceAll("\\\\", "/"), "/skill"),
  };
  try {
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  } catch {}

  let out = "";
  child.stdout.on("data", (c) => {
    out += String(c);
  });

  const code: number = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (c) => resolve(typeof c === "number" ? c : 1));
  }).finally(() => {
    params.signal.removeEventListener("abort", kill);
    kill();
  });

  if (code !== 0 && !out.trim()) throw new Error(`policy_violation:container_runtime_failed:${code}`);
  let parsed: any;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    throw new Error("policy_violation:container_runtime_bad_output");
  }
  if (!parsed?.ok) throw new Error(String(parsed?.error?.message ?? "skill_sandbox_error"));
  return {
    output: parsed.output,
    egress: Array.isArray(parsed.egress) ? parsed.egress : [],
    depsDigest: String(parsed.depsDigest ?? params.depsDigest),
    runtimeBackend: "container",
    degraded: false,
  };
}
