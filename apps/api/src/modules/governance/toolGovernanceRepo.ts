import type { Pool } from "pg";
import { getToolVersionByRef } from "../tools/toolRepo";
import { resolveSupplyChainPolicy, checkTrust, checkDependencyScan } from "@openslin/shared";
import { insertAuditEvent } from "../audit/auditRepo";
import { Errors } from "../../lib/errors";

export type ToolRolloutRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ToolActiveRow = {
  tenantId: string;
  name: string;
  activeToolRef: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolActiveOverrideRow = {
  tenantId: string;
  spaceId: string;
  name: string;
  activeToolRef: string;
  createdAt: string;
  updatedAt: string;
};

let toolActiveHasScopeCols: boolean | null = null;

async function detectToolActiveScopeCols(pool: Pool) {
  if (toolActiveHasScopeCols !== null) return toolActiveHasScopeCols;
  const res = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tool_active_versions'
        AND column_name IN ('scope_type', 'scope_id')
    `,
  );
  toolActiveHasScopeCols = (res.rowCount ?? 0) >= 2;
  return toolActiveHasScopeCols;
}

function toRollout(r: any): ToolRolloutRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    toolRef: r.tool_ref,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toActive(r: any): ToolActiveRow {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    activeToolRef: r.active_tool_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toActiveOverride(r: any): ToolActiveOverrideRow {
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    name: r.name,
    activeToolRef: r.active_tool_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function setToolRollout(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  enabled: boolean;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_rollouts (tenant_id, scope_type, scope_id, tool_ref, enabled)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, scope_type, scope_id, tool_ref)
      DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef, params.enabled],
  );
  return toRollout(res.rows[0]);
}

export async function deleteToolRollout(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
}) {
  const res = await params.pool.query(
    `
      DELETE FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef],
  );
  return res.rowCount ?? 0;
}

export async function isToolEnabled(params: { pool: Pool; tenantId: string; spaceId: string; toolRef: string }) {
  const space = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'space' AND scope_id = $2 AND tool_ref = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.toolRef],
  );
  if (space.rowCount) return Boolean(space.rows[0].enabled);

  const tenant = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_id = $1 AND tool_ref = $2
      LIMIT 1
    `,
    [params.tenantId, params.toolRef],
  );
  if (tenant.rowCount) return Boolean(tenant.rows[0].enabled);

  return false;
}

export async function getToolRolloutEnabled(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
}) {
  const res = await params.pool.query(
    `
      SELECT enabled
      FROM tool_rollouts
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND tool_ref = $4
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.toolRef],
  );
  if (!res.rowCount) return null;
  return Boolean(res.rows[0].enabled);
}

export async function setActiveToolRef(params: { pool: Pool; tenantId: string; name: string; toolRef: string }) {
  const hasScope = await detectToolActiveScopeCols(params.pool);
  if (!hasScope) {
    const res = await params.pool.query(
      `
        INSERT INTO tool_active_versions (tenant_id, name, active_tool_ref)
        VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, name)
        DO UPDATE SET active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
        RETURNING *
      `,
      [params.tenantId, params.name, params.toolRef],
    );
    return toActive(res.rows[0]);
  }
  try {
    const res = await params.pool.query(
      `
        INSERT INTO tool_active_versions (tenant_id, scope_type, scope_id, name, active_tool_ref)
        VALUES ($1,'tenant',$1,$2,$3)
        ON CONFLICT (tenant_id, name)
        DO UPDATE SET scope_type = EXCLUDED.scope_type, scope_id = EXCLUDED.scope_id, active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
        RETURNING *
      `,
      [params.tenantId, params.name, params.toolRef],
    );
    return toActive(res.rows[0]);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.includes("no unique or exclusion constraint")) throw e;
  }
  const res = await params.pool.query(
    `
      INSERT INTO tool_active_versions (tenant_id, scope_type, scope_id, name, active_tool_ref)
      VALUES ($1,'tenant',$1,$2,$3)
      ON CONFLICT (tenant_id, scope_type, scope_id, name)
      DO UPDATE SET active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.name, params.toolRef],
  );
  return toActive(res.rows[0]);
}

export async function clearActiveToolRef(params: { pool: Pool; tenantId: string; name: string }) {
  const hasScope = await detectToolActiveScopeCols(params.pool);
  const res = await params.pool.query(
    hasScope
      ? `
        DELETE FROM tool_active_versions
        WHERE tenant_id = $1 AND name = $2 AND scope_type = 'tenant' AND scope_id = $1
      `
      : `
        DELETE FROM tool_active_versions
        WHERE tenant_id = $1 AND name = $2
      `,
    [params.tenantId, params.name],
  );
  return res.rowCount ?? 0;
}

export async function setActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string; toolRef: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO tool_active_overrides (tenant_id, space_id, name, active_tool_ref)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, space_id, name)
      DO UPDATE SET active_tool_ref = EXCLUDED.active_tool_ref, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.name, params.toolRef],
  );
  return toActiveOverride(res.rows[0]);
}

export async function clearActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string }) {
  const res = await params.pool.query(
    `
      DELETE FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND name = $3
    `,
    [params.tenantId, params.spaceId, params.name],
  );
  return res.rowCount ?? 0;
}

export async function getActiveToolOverride(params: { pool: Pool; tenantId: string; spaceId: string; name: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2 AND name = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.name],
  );
  if (!res.rowCount) return null;
  return toActiveOverride(res.rows[0]);
}

export async function listActiveToolOverrides(params: { pool: Pool; tenantId: string; spaceId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_active_overrides
      WHERE tenant_id = $1 AND space_id = $2
      ORDER BY name ASC
    `,
    [params.tenantId, params.spaceId],
  );
  return res.rows.map(toActiveOverride);
}

export async function getActiveToolRef(params: { pool: Pool; tenantId: string; name: string }) {
  const hasScope = await detectToolActiveScopeCols(params.pool);
  const res = await params.pool.query(
    hasScope
      ? `
        SELECT *
        FROM tool_active_versions
        WHERE tenant_id = $1 AND name = $2 AND scope_type = 'tenant' AND scope_id = $1
        LIMIT 1
      `
      : `
        SELECT *
        FROM tool_active_versions
        WHERE tenant_id = $1 AND name = $2
        LIMIT 1
      `,
    [params.tenantId, params.name],
  );
  if (!res.rowCount) return null;
  return toActive(res.rows[0]);
}

export async function listActiveToolRefs(params: { pool: Pool; tenantId: string }) {
  const hasScope = await detectToolActiveScopeCols(params.pool);
  const res = await params.pool.query(
    hasScope
      ? `
        SELECT *
        FROM tool_active_versions
        WHERE tenant_id = $1 AND scope_type = 'tenant' AND scope_id = $1
        ORDER BY name ASC
      `
      : `
        SELECT *
        FROM tool_active_versions
        WHERE tenant_id = $1
        ORDER BY name ASC
      `,
    [params.tenantId],
  );
  return res.rows.map(toActive);
}

export async function listToolRollouts(params: { pool: Pool; tenantId: string; scopeType?: "tenant" | "space"; scopeId?: string }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.scopeType) {
    where.push(`scope_type = $${idx++}`);
    args.push(params.scopeType);
  }
  if (params.scopeId) {
    where.push(`scope_id = $${idx++}`);
    args.push(params.scopeId);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM tool_rollouts
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT 500
    `,
    args,
  );
  return res.rows.map(toRollout);
}

/* ================================================================== */
/*  High-level: enable / disable tool for a scope                      */
/* ================================================================== */

export interface EnableToolParams {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  toolRef: string;
  /** Subject performing the action (for audit). */
  subjectId?: string;
  /** Trace ID for audit correlation. */
  traceId?: string;
  /** Policy decision from requirePermission (for audit). */
  policyDecision?: any;
}

export interface EnableToolResult {
  rollout: ToolRolloutRow;
  previousEnabled: boolean | null;
}

/**
 * Enable a tool for a given scope (tenant or space).
 *
 * Validates:
 *  1. Tool version exists and is released
 *  2. Supply chain gate: trust + scan (for artifact-based tools)
 *
 * Then writes the rollout and an audit event.
 */
export async function enableToolForScope(params: EnableToolParams): Promise<EnableToolResult> {
  const { pool, tenantId, scopeType, scopeId, toolRef } = params;

  // Validate version exists and is released
  const ver = await getToolVersionByRef(pool, tenantId, toolRef);
  if (!ver || ver.status !== "released") {
    throw Errors.badRequest("工具版本不存在或未发布");
  }

  // Supply chain gate for artifact-based tools
  if (ver.artifactRef) {
    const policy = resolveSupplyChainPolicy();
    const t = checkTrust(policy, ver.trustSummary);
    const s = checkDependencyScan(policy, ver.scanSummary);
    if (!t.ok) throw Errors.trustNotVerified();
    if (!s.ok) throw Errors.scanNotPassed();
  }

  // Check previous state
  const previousEnabled = await getToolRolloutEnabled({ pool, tenantId, scopeType, scopeId, toolRef });

  // Write rollout
  const rollout = await setToolRollout({ pool, tenantId, scopeType, scopeId, toolRef, enabled: true });

  // Write audit event if state changed
  if (previousEnabled !== true) {
    await insertAuditEvent(pool, {
      subjectId: params.subjectId,
      tenantId,
      spaceId: scopeType === "space" ? scopeId : undefined,
      resourceType: "governance",
      action: "tool.enable",
      policyDecision: params.policyDecision,
      inputDigest: { scopeType, scopeId, toolRef },
      outputDigest: { enabled: true, previousEnabled },
      result: "success",
      traceId: params.traceId ?? "",
    });
  }

  return { rollout, previousEnabled };
}

/**
 * Disable a tool for a given scope (tenant or space).
 *
 * Writes the rollout and an audit event.
 */
export async function disableToolForScope(params: EnableToolParams): Promise<EnableToolResult> {
  const { pool, tenantId, scopeType, scopeId, toolRef } = params;

  // Check previous state
  const previousEnabled = await getToolRolloutEnabled({ pool, tenantId, scopeType, scopeId, toolRef });

  // Write rollout
  const rollout = await setToolRollout({ pool, tenantId, scopeType, scopeId, toolRef, enabled: false });

  // Write audit event if state changed
  if (previousEnabled !== false) {
    await insertAuditEvent(pool, {
      subjectId: params.subjectId,
      tenantId,
      spaceId: scopeType === "space" ? scopeId : undefined,
      resourceType: "governance",
      action: "tool.disable",
      policyDecision: params.policyDecision,
      inputDigest: { scopeType, scopeId, toolRef },
      outputDigest: { enabled: false, previousEnabled },
      result: "success",
      traceId: params.traceId ?? "",
    });
  }

  return { rollout, previousEnabled };
}
