import crypto from "node:crypto";
import type { Pool } from "pg";

function apiBase() {
  const raw = String(process.env.WORKER_API_BASE ?? process.env.API_BASE ?? "http://localhost:3001").trim();
  return raw.replace(/\/+$/, "");
}

function authnMode() {
  const mode = String(process.env.AUTHN_MODE ?? "").trim().toLowerCase();
  if (mode === "pat") return "pat" as const;
  if (mode === "hmac") return "hmac" as const;
  return "dev" as const;
}

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function buildDevToken(params: { subjectId: string; spaceId?: string | null }) {
  const sid = params.spaceId ? String(params.spaceId) : "";
  return sid ? `${params.subjectId}@${sid}` : params.subjectId;
}

function buildHmacToken(params: { tenantId: string; subjectId: string; spaceId?: string | null; ttlSec: number }) {
  const secret = String(process.env.AUTHN_HMAC_SECRET ?? "");
  if (!secret) throw new Error("policy_violation:missing_authn_hmac_secret");
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, Math.min(3600, Math.floor(params.ttlSec)));
  const payload = {
    tenantId: params.tenantId,
    subjectId: params.subjectId,
    spaceId: params.spaceId ? String(params.spaceId) : undefined,
    exp,
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest().toString("base64url");
  return `${payloadPart}.${sig}`;
}

function genPatToken() {
  const raw = crypto.randomBytes(24).toString("base64url");
  return `pat_${raw}`;
}

async function createWorkerPatToken(params: { pool: Pool; tenantId: string; spaceId: string | null; subjectId: string; ttlSec: number }) {
  const token = genPatToken();
  const tokenHash = sha256Hex(token);
  const ttl = Math.max(10, Math.min(3600, Math.floor(params.ttlSec)));
  await params.pool.query(
    `
      INSERT INTO auth_tokens (tenant_id, space_id, subject_id, name, token_hash, expires_at)
      VALUES ($1,$2,$3,$4,$5, now() + ($6::int || ' seconds')::interval)
    `,
    [params.tenantId, params.spaceId, params.subjectId, "worker_ephemeral", tokenHash, ttl],
  );
  return token;
}

async function buildAuthorization(params: { pool: Pool; tenantId: string; spaceId: string | null; subjectId: string }) {
  const mode = authnMode();
  if (mode === "hmac") return `Bearer ${buildHmacToken({ tenantId: params.tenantId, subjectId: params.subjectId, spaceId: params.spaceId, ttlSec: 60 })}`;
  if (mode === "pat") return `Bearer ${await createWorkerPatToken({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, ttlSec: 60 })}`;
  return `Bearer ${buildDevToken({ subjectId: params.subjectId, spaceId: params.spaceId })}`;
}

export async function callDataPlaneJson(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  traceId: string;
  runId?: string | null;
  stepId?: string | null;
  policySnapshotRef?: string | null;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  idempotencyKey?: string | null;
  schemaName?: string | null;
  body?: any;
}) {
  const base = apiBase();
  const url = `${base}${params.path.startsWith("/") ? "" : "/"}${params.path}`;
  const authorization = await buildAuthorization({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId });
  const headers: Record<string, string> = {
    authorization,
    "content-type": "application/json",
    "x-trace-id": params.traceId,
    "x-tenant-id": params.tenantId,
  };
  if (params.spaceId) headers["x-space-id"] = params.spaceId;
  if (params.schemaName) headers["x-schema-name"] = params.schemaName;
  if (params.idempotencyKey) headers["idempotency-key"] = params.idempotencyKey;
  if (params.runId) headers["x-run-id"] = params.runId;
  if (params.stepId) headers["x-step-id"] = params.stepId;
  if (params.policySnapshotRef) headers["x-policy-snapshot-ref"] = params.policySnapshotRef;

  const res = await fetch(url, {
    method: params.method,
    headers,
    body: params.method === "GET" ? undefined : JSON.stringify(params.body ?? {}),
  });
  let data: any = null;
  if (typeof (res as any)?.text === "function") {
    const text = await (res as any).text();
    data = text
      ? (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })()
      : null;
  } else if (typeof (res as any)?.json === "function") {
    try {
      data = await (res as any).json();
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const code = typeof (data as any)?.errorCode === "string" ? String((data as any).errorCode) : `HTTP_${res.status}`;
    throw new Error(code);
  }
  return data;
}
