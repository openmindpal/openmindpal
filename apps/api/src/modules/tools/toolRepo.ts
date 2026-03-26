import type { Pool, PoolClient } from "pg";
import type { ToolPublish } from "./toolModel";

type Q = Pool | PoolClient;

export type ToolDefinition = {
  tenantId: string;
  name: string;
  displayName: any;
  description: any;
  scope: "read" | "write" | null;
  resourceType: string | null;
  action: string | null;
  idempotencyRequired: boolean | null;
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  /** Skill layer classification: kernel / builtin / extension. */
  sourceLayer: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolVersion = {
  tenantId: string;
  name: string;
  version: number;
  toolRef: string;
  status: string;
  depsDigest: string | null;
  artifactRef: string | null;
  scanSummary: any;
  trustSummary: any;
  sbomSummary: any;
  sbomDigest: string | null;
  inputSchema: any;
  outputSchema: any;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
};

function toDef(r: any): ToolDefinition {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    scope: r.scope ?? null,
    resourceType: r.resource_type ?? null,
    action: r.action ?? null,
    idempotencyRequired: r.idempotency_required ?? null,
    riskLevel: r.risk_level,
    approvalRequired: r.approval_required,
    sourceLayer: r.source_layer ?? "builtin",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toVer(r: any): ToolVersion {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    version: r.version,
    toolRef: r.tool_ref,
    status: r.status,
    depsDigest: r.deps_digest,
    artifactRef: r.artifact_ref ?? null,
    scanSummary: r.scan_summary ?? null,
    trustSummary: r.trust_summary ?? null,
    sbomSummary: r.sbom_summary ?? null,
    sbomDigest: r.sbom_digest ?? null,
    inputSchema: r.input_schema,
    outputSchema: r.output_schema,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function formatToolRef(name: string, version: number) {
  return `${name}@${version}`;
}

export async function upsertToolDefinition(params: {
  pool: Q;
  tenantId: string;
  name: string;
  displayName?: any;
  description?: any;
  scope?: "read" | "write";
  resourceType?: string;
  action?: string;
  idempotencyRequired?: boolean;
  riskLevel?: "low" | "medium" | "high";
  approvalRequired?: boolean;
}) {
  const hasRiskLevel = params.riskLevel !== undefined;
  const hasApprovalRequired = params.approvalRequired !== undefined;
  const res = await params.pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, display_name, description, scope, resource_type, action, idempotency_required, risk_level, approval_required)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, name) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, tool_definitions.display_name),
          description = COALESCE(EXCLUDED.description, tool_definitions.description),
          scope = COALESCE(EXCLUDED.scope, tool_definitions.scope),
          resource_type = COALESCE(EXCLUDED.resource_type, tool_definitions.resource_type),
          action = COALESCE(EXCLUDED.action, tool_definitions.action),
          idempotency_required = COALESCE(EXCLUDED.idempotency_required, tool_definitions.idempotency_required),
          risk_level = CASE WHEN $11 THEN EXCLUDED.risk_level ELSE tool_definitions.risk_level END,
          approval_required = CASE WHEN $12 THEN EXCLUDED.approval_required ELSE tool_definitions.approval_required END,
          updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.name,
      params.displayName ?? null,
      params.description ?? null,
      params.scope ?? null,
      params.resourceType ?? null,
      params.action ?? null,
      params.idempotencyRequired ?? null,
      params.riskLevel ?? "low",
      params.approvalRequired ?? false,
      hasRiskLevel,
      hasApprovalRequired,
    ],
  );
  return toDef(res.rows[0]);
}

export async function listToolDefinitions(pool: Pool, tenantId: string) {
  const res = await pool.query(
    "SELECT * FROM tool_definitions WHERE tenant_id = $1 ORDER BY name ASC",
    [tenantId],
  );
  return res.rows.map(toDef);
}

export async function getToolDefinition(pool: Pool, tenantId: string, name: string) {
  const res = await pool.query(
    "SELECT * FROM tool_definitions WHERE tenant_id = $1 AND name = $2 LIMIT 1",
    [tenantId, name],
  );
  if (res.rowCount === 0) return null;
  return toDef(res.rows[0]);
}

export async function listToolVersions(pool: Pool, tenantId: string, name: string) {
  const res = await pool.query(
    "SELECT * FROM tool_versions WHERE tenant_id = $1 AND name = $2 ORDER BY version DESC",
    [tenantId, name],
  );
  return res.rows.map(toVer);
}

export async function getToolVersionByRef(pool: Pool, tenantId: string, toolRef: string) {
  const res = await pool.query(
    "SELECT * FROM tool_versions WHERE tenant_id = $1 AND tool_ref = $2 LIMIT 1",
    [tenantId, toolRef],
  );
  if (res.rowCount === 0) return null;
  return toVer(res.rows[0]);
}

export async function getLatestReleasedToolVersion(pool: Pool, tenantId: string, name: string) {
  const res = await pool.query(
    `
      SELECT *
      FROM tool_versions
      WHERE tenant_id = $1 AND name = $2 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [tenantId, name],
  );
  if (res.rowCount === 0) return null;
  return toVer(res.rows[0]);
}

export async function publishToolVersion(params: {
  pool: Q;
  tenantId: string;
  name: string;
  publish: ToolPublish;
}) {
  await upsertToolDefinition({
    pool: params.pool,
    tenantId: params.tenantId,
    name: params.name,
    displayName: params.publish.displayName,
    description: params.publish.description,
    scope: params.publish.scope,
    resourceType: params.publish.resourceType,
    action: params.publish.action,
    idempotencyRequired: params.publish.idempotencyRequired,
    riskLevel: params.publish.riskLevel,
    approvalRequired: params.publish.approvalRequired,
  });

  const latest = await params.pool.query(
    "SELECT version FROM tool_versions WHERE tenant_id = $1 AND name = $2 ORDER BY version DESC LIMIT 1",
    [params.tenantId, params.name],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const toolRef = formatToolRef(params.name, nextVersion);

  const res = await params.pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, scan_summary, trust_summary, sbom_summary, sbom_digest, input_schema, output_schema)
      VALUES ($1, $2, $3, $4, 'released', $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.name,
      nextVersion,
      toolRef,
      params.publish.depsDigest ?? null,
      params.publish.artifactRef ?? null,
      (params.publish as any).scanSummary ?? null,
      (params.publish as any).trustSummary ?? null,
      (params.publish as any).sbomSummary ?? null,
      (params.publish as any).sbomDigest ?? null,
      params.publish.inputSchema ?? null,
      params.publish.outputSchema ?? null,
    ],
  );

  return toVer(res.rows[0]);
}
