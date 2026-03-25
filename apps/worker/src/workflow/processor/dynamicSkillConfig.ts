import type { Pool } from "pg";
import { decryptSecretPayload } from "../../secrets/envelope";

export function getSkillRuntimeBackendPref(): "process" | "container" | "remote" | "auto" {
  const raw = String(process.env.SKILL_RUNTIME_BACKEND ?? "").trim().toLowerCase();
  if (raw === "container") return "container";
  if (raw === "remote") return "remote";
  if (raw === "auto") return "auto";
  if (raw === "process") return "process";
  return process.env.NODE_ENV === "production" ? "auto" : "process";
}

export function getSkillRuntimeContainerImage() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_IMAGE ?? "").trim();
  return raw || "node:20-alpine";
}

export function getSkillRuntimeContainerUser() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_USER ?? "").trim();
  return raw || "1000:1000";
}

function getSkillRuntimeRemoteEndpointOverride() {
  const raw = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
  return raw || null;
}

export async function loadRemoteRunnerConfig(params: { pool: Pool; tenantId: string; masterKey: string }) {
  const endpointOverride = getSkillRuntimeRemoteEndpointOverride();
  if (endpointOverride) return { endpoint: endpointOverride, bearerToken: null };

  const res = await params.pool.query(
    "SELECT endpoint, auth_secret_id FROM skill_runtime_runners WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC LIMIT 1",
    [params.tenantId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  const endpoint = String(r.endpoint ?? "");
  const authSecretId = r.auth_secret_id ? String(r.auth_secret_id) : "";
  if (!endpoint) return null;

  if (!authSecretId) return { endpoint, bearerToken: null };

  const sr = await params.pool.query(
    `
      SELECT scope_type, scope_id, status, key_version, enc_format, encrypted_payload
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [params.tenantId, authSecretId],
  );
  if (!sr.rowCount) throw new Error("policy_violation:remote_runner_secret_not_found");
  const row = sr.rows[0] as any;
  if (String(row.status) !== "active") throw new Error("policy_violation:remote_runner_secret_not_active");
  const decrypted = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: params.masterKey,
    scopeType: String(row.scope_type),
    scopeId: String(row.scope_id),
    keyVersion: Number(row.key_version),
    encFormat: String(row.enc_format ?? "legacy.a256gcm"),
    encryptedPayload: row.encrypted_payload,
  });
  const obj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
  const token = typeof obj.bearerToken === "string" ? obj.bearerToken : typeof obj.token === "string" ? obj.token : "";
  if (!token) throw new Error("policy_violation:remote_runner_secret_missing_token");
  return { endpoint, bearerToken: token };
}

export function allowSkillRuntimeContainerFallback() {
  const raw = String(process.env.SKILL_RUNTIME_CONTAINER_FALLBACK ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}
