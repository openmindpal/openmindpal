import type { Pool } from "pg";
import {
  resolveSkillRuntimeBackend,
  resolveSkillRuntimeContainerImage,
  resolveSkillRuntimeContainerUser,
  resolveSkillRuntimeRemoteEndpoint,
  resolveSkillRuntimeContainerFallback,
  type SkillRuntimeBackend,
} from "@openslin/shared";
import { decryptSecretPayload } from "../../secrets/envelope";

/**
 * 获取 Skill 运行时后端偏好
 * 统一从 @openslin/shared 解析
 */
export function getSkillRuntimeBackendPref(): SkillRuntimeBackend {
  return resolveSkillRuntimeBackend().value;
}

/**
 * 获取容器运行时镜像
 */
export function getSkillRuntimeContainerImage(): string {
  return resolveSkillRuntimeContainerImage().value;
}

/**
 * 获取容器运行时用户
 */
export function getSkillRuntimeContainerUser(): string {
  return resolveSkillRuntimeContainerUser().value;
}

function getSkillRuntimeRemoteEndpointOverride(): string | null {
  return resolveSkillRuntimeRemoteEndpoint().value;
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

/**
 * 是否允许容器隔离回退到 process 模式
 */
export function allowSkillRuntimeContainerFallback(): boolean {
  return resolveSkillRuntimeContainerFallback().value;
}
