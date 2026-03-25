import type { Pool } from "pg";

export async function writeSecretUsageEvent(params: {
  pool: Pool;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  connectorInstanceId: string;
  secretId: string;
  credentialVersion: number;
  scene: string;
  result: "success" | "denied" | "error";
  traceId?: string | null;
  requestId?: string | null;
}) {
  const credentialVersion =
    typeof params.credentialVersion === "number" && Number.isFinite(params.credentialVersion) && params.credentialVersion > 0 ? Math.round(params.credentialVersion) : 1;
  await params.pool.query(
    `
      INSERT INTO secret_usage_events (
        tenant_id, scope_type, scope_id, connector_instance_id, secret_id, credential_version, scene, result, trace_id, request_id
      ) VALUES (
        $1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10
      )
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.connectorInstanceId,
      params.secretId,
      credentialVersion,
      params.scene,
      params.result,
      params.traceId ?? null,
      params.requestId ?? null,
    ],
  );
}

export async function listSecretUsageEvents(params: { pool: Pool; tenantId: string; connectorInstanceId: string; limit?: number }) {
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0 ? Math.min(200, Math.round(params.limit)) : 50;
  const res = await params.pool.query(
    `
      SELECT *
      FROM secret_usage_events
      WHERE tenant_id = $1 AND connector_instance_id = $2::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `,
    [params.tenantId, params.connectorInstanceId, limit],
  );
  return res.rows as any[];
}

