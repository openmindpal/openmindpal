import type { Pool } from "pg";

export type SkillRuntimeRunner = {
  runnerId: string;
  endpoint: string;
  enabled: boolean;
  authSecretId: string | null;
  capabilities: any | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillTrustedKey = {
  keyId: string;
  publicKeyPem: string;
  status: "active" | "disabled";
  rotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRunner(r: any): SkillRuntimeRunner {
  return {
    runnerId: String(r.runner_id),
    endpoint: String(r.endpoint),
    enabled: Boolean(r.enabled),
    authSecretId: r.auth_secret_id ? String(r.auth_secret_id) : null,
    capabilities: r.capabilities ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function toKey(r: any): SkillTrustedKey {
  const st0 = String(r.status ?? "active").toLowerCase();
  const status = st0 === "disabled" ? "disabled" : "active";
  return {
    keyId: String(r.key_id),
    publicKeyPem: String(r.public_key_pem),
    status,
    rotatedAt: r.rotated_at ? new Date(r.rotated_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function listSkillRuntimeRunners(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM skill_runtime_runners WHERE tenant_id = $1 ORDER BY created_at DESC", [params.tenantId]);
  return res.rows.map(toRunner);
}

export async function createSkillRuntimeRunner(params: {
  pool: Pool;
  tenantId: string;
  runnerId: string;
  endpoint: string;
  enabled: boolean;
  authSecretId: string | null;
  capabilities: any | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO skill_runtime_runners (tenant_id, runner_id, endpoint, enabled, auth_secret_id, capabilities)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.runnerId, params.endpoint, params.enabled, params.authSecretId, params.capabilities],
  );
  return toRunner(res.rows[0]);
}

export async function setSkillRuntimeRunnerEnabled(params: { pool: Pool; tenantId: string; runnerId: string; enabled: boolean }) {
  const res = await params.pool.query(
    "UPDATE skill_runtime_runners SET enabled = $3, updated_at = now() WHERE tenant_id = $1 AND runner_id = $2 RETURNING *",
    [params.tenantId, params.runnerId, params.enabled],
  );
  if (res.rowCount === 0) return null;
  return toRunner(res.rows[0]);
}

export async function setSkillRuntimeRunnerCapabilities(params: { pool: Pool; tenantId: string; runnerId: string; capabilities: any | null }) {
  const res = await params.pool.query(
    "UPDATE skill_runtime_runners SET capabilities = $3, updated_at = now() WHERE tenant_id = $1 AND runner_id = $2 RETURNING *",
    [params.tenantId, params.runnerId, params.capabilities],
  );
  if (res.rowCount === 0) return null;
  return toRunner(res.rows[0]);
}

export async function getSkillRuntimeRunner(params: { pool: Pool; tenantId: string; runnerId: string }) {
  const res = await params.pool.query("SELECT * FROM skill_runtime_runners WHERE tenant_id = $1 AND runner_id = $2 LIMIT 1", [params.tenantId, params.runnerId]);
  if (res.rowCount === 0) return null;
  return toRunner(res.rows[0]);
}

export async function getEnabledSkillRuntimeRunner(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM skill_runtime_runners WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC LIMIT 1",
    [params.tenantId],
  );
  if (res.rowCount === 0) return null;
  return toRunner(res.rows[0]);
}

export async function listSkillTrustedKeys(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM skill_trusted_keys WHERE tenant_id = $1 ORDER BY created_at DESC", [params.tenantId]);
  return res.rows.map(toKey);
}

export async function upsertSkillTrustedKey(params: {
  pool: Pool;
  tenantId: string;
  keyId: string;
  publicKeyPem: string;
  status: "active" | "disabled";
}) {
  const res = await params.pool.query(
    `
      INSERT INTO skill_trusted_keys (tenant_id, key_id, public_key_pem, status)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, key_id)
      DO UPDATE SET public_key_pem = EXCLUDED.public_key_pem, status = EXCLUDED.status, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.keyId, params.publicKeyPem, params.status],
  );
  return toKey(res.rows[0]);
}

export async function rotateSkillTrustedKey(params: { pool: Pool; tenantId: string; keyId: string }) {
  const res = await params.pool.query(
    "UPDATE skill_trusted_keys SET status = 'disabled', rotated_at = now(), updated_at = now() WHERE tenant_id = $1 AND key_id = $2 RETURNING *",
    [params.tenantId, params.keyId],
  );
  if (res.rowCount === 0) return null;
  return toKey(res.rows[0]);
}

export async function listActiveSkillTrustedKeys(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM skill_trusted_keys WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC", [params.tenantId]);
  return res.rows.map(toKey);
}
