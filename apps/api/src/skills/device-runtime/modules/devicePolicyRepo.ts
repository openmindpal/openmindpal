import type { Pool } from "pg";

export type DevicePolicyRow = {
  deviceId: string;
  tenantId: string;
  allowedTools: string[] | null;
  filePolicy: any;
  networkPolicy: any;
  uiPolicy: any;
  evidencePolicy: any;
  limits: any;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): DevicePolicyRow {
  return {
    deviceId: r.device_id,
    tenantId: r.tenant_id,
    allowedTools: Array.isArray(r.allowed_tools) ? (r.allowed_tools as string[]) : null,
    filePolicy: r.file_policy ?? null,
    networkPolicy: r.network_policy ?? null,
    uiPolicy: r.ui_policy ?? null,
    evidencePolicy: r.evidence_policy ?? null,
    limits: r.limits ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getDevicePolicy(params: { pool: Pool; tenantId: string; deviceId: string }) {
  const res = await params.pool.query("SELECT * FROM device_policies WHERE tenant_id = $1 AND device_id = $2 LIMIT 1", [params.tenantId, params.deviceId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function upsertDevicePolicy(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  allowedTools?: string[] | null;
  filePolicy?: any;
  networkPolicy?: any;
  uiPolicy?: any;
  evidencePolicy?: any;
  limits?: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO device_policies (device_id, tenant_id, allowed_tools, file_policy, network_policy, ui_policy, evidence_policy, limits)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
      ON CONFLICT (device_id)
      DO UPDATE SET
        allowed_tools = EXCLUDED.allowed_tools,
        file_policy = EXCLUDED.file_policy,
        network_policy = EXCLUDED.network_policy,
        ui_policy = EXCLUDED.ui_policy,
        evidence_policy = EXCLUDED.evidence_policy,
        limits = EXCLUDED.limits,
        updated_at = now()
      RETURNING *
    `,
    [
      params.deviceId,
      params.tenantId,
      params.allowedTools ? JSON.stringify(params.allowedTools) : null,
      params.filePolicy ? JSON.stringify(params.filePolicy) : null,
      params.networkPolicy ? JSON.stringify(params.networkPolicy) : null,
      params.uiPolicy ? JSON.stringify(params.uiPolicy) : null,
      params.evidencePolicy ? JSON.stringify(params.evidencePolicy) : null,
      params.limits ? JSON.stringify(params.limits) : null,
    ],
  );
  return toRow(res.rows[0]);
}
