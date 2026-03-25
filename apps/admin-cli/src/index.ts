#!/usr/bin/env node
type Opts = Record<string, string | boolean>;

function parseCli(argv: string[]) {
  const args = argv.slice(2);
  const positionals: string[] = [];
  const options: Opts = {};
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) {
      positionals.push(a);
      i += 1;
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      i += 1;
      continue;
    }
    options[key] = next;
    i += 2;
  }
  const command = positionals.join(" ");
  return { command, options };
}

function getStringOpt(opts: Opts, key: string) {
  const v = opts[key];
  return typeof v === "string" ? v : "";
}

function apiBase(opts: Opts) {
  return getStringOpt(opts, "apiBase") || process.env.API_BASE || "http://localhost:3001";
}

function apiToken(opts: Opts) {
  return getStringOpt(opts, "token") || process.env.API_TOKEN || "";
}

async function apiGetJson(params: { apiBase: string; path: string; token: string }) {
  const res = await fetch(`${params.apiBase}${params.path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${params.token}`,
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

async function cmdAuditVerify(opts: Opts) {
  const base = apiBase(opts);
  const token = apiToken(opts);
  if (!token) throw new Error("missing_token");
  const tenantId = getStringOpt(opts, "tenantId");
  const from = getStringOpt(opts, "from");
  const to = getStringOpt(opts, "to");
  const limit = getStringOpt(opts, "limit");
  const qs = new URLSearchParams();
  if (tenantId) qs.set("tenantId", tenantId);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (limit) qs.set("limit", limit);
  const path = `/audit/verify${qs.size ? `?${qs.toString()}` : ""}`;
  const r = await apiGetJson({ apiBase: base, path, token });
  console.log(JSON.stringify({ status: r.status, result: r.json }, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}

async function cmdModelsUsage(opts: Opts) {
  const base = apiBase(opts);
  const token = apiToken(opts);
  if (!token) throw new Error("missing_token");
  const scope = getStringOpt(opts, "scope");
  const range = getStringOpt(opts, "range");
  const purpose = getStringOpt(opts, "purpose");
  const modelRef = getStringOpt(opts, "modelRef");
  const qs = new URLSearchParams();
  if (scope) qs.set("scope", scope);
  if (range) qs.set("range", range);
  if (purpose) qs.set("purpose", purpose);
  if (modelRef) qs.set("modelRef", modelRef);
  const path = `/governance/models/usage${qs.size ? `?${qs.toString()}` : ""}`;
  const r = await apiGetJson({ apiBase: base, path, token });
  console.log(JSON.stringify({ status: r.status, result: r.json }, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}

async function cmdQueueStatus(opts: Opts) {
  const base = apiBase(opts);
  const token = apiToken(opts);
  if (!token) throw new Error("missing_token");
  const scope = getStringOpt(opts, "scope");
  const qs = new URLSearchParams();
  if (scope) qs.set("scope", scope);
  const path = `/diagnostics${qs.size ? `?${qs.toString()}` : ""}`;
  const r = await apiGetJson({ apiBase: base, path, token });
  console.log(JSON.stringify({ status: r.status, result: r.json }, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}

async function cmdChangesetStatus(opts: Opts) {
  const base = apiBase(opts);
  const token = apiToken(opts);
  if (!token) throw new Error("missing_token");
  const id = getStringOpt(opts, "id");
  if (!id) throw new Error("missing_id");
  const r = await apiGetJson({ apiBase: base, path: `/governance/changesets/${encodeURIComponent(id)}`, token });
  console.log(JSON.stringify({ status: r.status, result: r.json }, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}

async function main() {
  const { command, options } = parseCli(process.argv);
  try {
    if (command === "audit verify") await cmdAuditVerify(options);
    else if (command === "models usage") await cmdModelsUsage(options);
    else if (command === "queue status") await cmdQueueStatus(options);
    else if (command === "changeset status") await cmdChangesetStatus(options);
    else {
      console.log("openslin-admin commands:");
      console.log("  audit verify --token <token> [--apiBase <url>] [--tenantId <id>] [--from <iso>] [--to <iso>] [--limit <n>]");
      console.log("  models usage --token <token> [--apiBase <url>] [--scope tenant|space] [--range 24h] [--purpose <p>] [--modelRef <ref>]");
      console.log("  queue status --token <token> [--apiBase <url>] [--scope tenant|space]");
      console.log("  changeset status --token <token> --id <changesetId> [--apiBase <url>]");
    }
  } catch (e: any) {
    console.error(String(e?.message ?? "failed"));
    process.exitCode = 1;
  }
}

void main();
