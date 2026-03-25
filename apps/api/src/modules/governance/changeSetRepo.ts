import type { Pool, PoolClient } from "pg";
import { Errors } from "../../lib/errors";
import { validatePolicyExpr, resolveSupplyChainPolicy, supplyChainGate as runSupplyChainGate, type IsolationLevel } from "@openslin/shared";
import { getToolDefinition, getToolVersionByRef } from "../tools/toolRepo";
import { getEvalSuite, getLatestEvalRunForChangeSet, listChangeSetEvalBindings } from "./evalRepo";
import { evalPassed } from "./evalLogic";
import { isSupportedModelProvider } from "../../lib/modelProviderContract";
import { computeSchemaCompatReportV1 } from "../metadata/compat";
import { ensureSchemaI18nFallback } from "../metadata/i18n";
import { schemaDefSchema } from "../metadata/schemaModel";
import { clearActiveSchemaOverride, clearActiveSchemaVersion, getActiveSchemaOverride, getByNameVersion, getEffectiveSchema, getPreviousReleasedSchemaVersion, publishNewReleased, setActiveSchemaOverride, setActiveSchemaVersion } from "../metadata/schemaRepo";
import { pageDraftSchema } from "../../skills/ui-page-config/modules/pageModel";
import { cloneReleasedVersion, getDraft as getPageDraft, getLatestReleased as getLatestReleasedPage, publishFromDraft as publishPageFromDraft, rollbackToPreviousReleased as rollbackPageToPreviousReleased, setPageVersionStatus } from "../../skills/ui-page-config/modules/pageRepo";
import { sha256Hex, stableStringify } from "../../lib/digest";
import { clearActiveVersion as clearWorkbenchActiveVersion, getActiveVersion as getWorkbenchActiveVersion, getCanaryConfig as getWorkbenchCanaryConfig, getDraftVersion as getWorkbenchDraft, getLatestReleasedVersion as getWorkbenchLatestReleased, getPreviousReleasedVersion as getWorkbenchPreviousReleased, publishFromDraft as publishWorkbenchFromDraft, rollbackActiveToPreviousReleased as rollbackWorkbenchActiveToPreviousReleased, setActiveVersion as setWorkbenchActiveVersion, setCanaryConfig as setWorkbenchCanaryConfig, clearCanaryConfig as clearWorkbenchCanaryConfig } from "../../skills/workbench-manager/modules/workbenchRepo";
import { bumpPolicyCacheEpoch, getPolicyCacheEpoch } from "../auth/policyCacheEpochRepo";
import { getPolicyVersion } from "../auth/policyVersionRepo";
import { getEnabledSkillRuntimeRunner } from "./skillRuntimeRepo";

/** Shared helper: run supplyChainGate with resolved policy. */
function _validateToolSupplyChain(
  trustSummary: any, scanSummary: any, sbomSummary: any, sbomDigest: any,
) {
  const policy = resolveSupplyChainPolicy();
  return runSupplyChainGate({ policy, trustSummary, scanSummary, sbomSummary, sbomDigest, requestedIsolation: "auto" });
}
import {
  clearActiveToolOverride,
  clearActiveToolRef,
  deleteToolRollout,
  getActiveToolOverride,
  getActiveToolRef,
  getToolRolloutEnabled,
  setActiveToolOverride,
  setActiveToolRef,
  setToolRollout,
} from "./toolGovernanceRepo";

export type ChangeSetStatus = "draft" | "submitted" | "approved" | "released" | "rolled_back";

export type ChangeSetRow = {
  id: string;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  title: string;
  status: ChangeSetStatus;
  riskLevel: "low" | "medium" | "high";
  requiredApprovals: number;
  canaryTargets: string[] | null;
  canaryReleasedAt: string | null;
  promotedAt: string | null;
  createdBy: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  rollbackOf: string | null;
  rollbackData: any;
  createdAt: string;
  updatedAt: string;
};

export type ChangeSetItemRow = {
  id: string;
  changesetId: string;
  kind:
    | "tool.enable"
    | "tool.disable"
    | "tool.set_active"
    | "ui.page.publish"
    | "ui.page.rollback"
    | "policy.cache.invalidate"
    | "policy.version.release"
    | "policy.publish"
    | "policy.set_active"
    | "policy.rollback"
    | "policy.set_override"
    | "workbench.plugin.publish"
    | "workbench.plugin.rollback"
    | "workbench.plugin.canary"
    | "schema.publish"
    | "schema.set_active"
    | "schema.rollback"
    | "model_routing.upsert"
    | "model_routing.disable"
    | "model_limits.set"
    | "tool_limits.set"
    | "artifact_policy.upsert";
  payload: any;
  createdAt: string;
};

function toCs(r: any): ChangeSetRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    title: r.title,
    status: r.status,
    riskLevel: r.risk_level,
    requiredApprovals: r.required_approvals,
    canaryTargets: Array.isArray(r.canary_targets) ? r.canary_targets : null,
    canaryReleasedAt: r.canary_released_at,
    promotedAt: r.promoted_at,
    createdBy: r.created_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    releasedBy: r.released_by,
    releasedAt: r.released_at,
    rollbackOf: r.rollback_of,
    rollbackData: r.rollback_data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toItem(r: any): ChangeSetItemRow {
  return {
    id: r.id,
    changesetId: r.changeset_id,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
  };
}

function client(pool: Pool | PoolClient) {
  return pool as any;
}

async function countApprovals(params: { pool: Pool | PoolClient; tenantId: string; changesetId: string }) {
  const res = await client(params.pool).query(
    `SELECT COUNT(*)::int AS c FROM governance_changeset_approvals WHERE tenant_id = $1 AND changeset_id = $2`,
    [params.tenantId, params.changesetId],
  );
  return res.rows[0].c as number;
}

export async function createChangeSet(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  title: string;
  createdBy: string;
  canaryTargets?: string[] | null;
}) {
  const canaryTargets = params.canaryTargets ? JSON.stringify(params.canaryTargets) : null;
  const res = await params.pool.query(
    `
      INSERT INTO governance_changesets (tenant_id, scope_type, scope_id, title, status, created_by, canary_targets)
      VALUES ($1,$2,$3,$4,'draft',$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.title, params.createdBy, canaryTargets],
  );
  return toCs(res.rows[0]);
}

export async function getChangeSet(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `SELECT * FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toCs(res.rows[0]);
}

export async function listChangeSets(params: { pool: Pool; tenantId: string; scopeType?: "tenant" | "space"; scopeId?: string; limit: number }) {
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
      FROM governance_changesets
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map(toCs);
}

export async function listChangeSetItems(params: { pool: Pool; tenantId: string; changesetId: string }) {
  const res = await params.pool.query(
    `
      SELECT i.*
      FROM governance_changeset_items i
      JOIN governance_changesets c ON c.id = i.changeset_id
      WHERE c.tenant_id = $1 AND c.id = $2
      ORDER BY i.created_at ASC
    `,
    [params.tenantId, params.changesetId],
  );
  return res.rows.map(toItem);
}

export async function addChangeSetItem(params: {
  pool: Pool;
  tenantId: string;
  changesetId: string;
  kind: ChangeSetItemRow["kind"];
  payload: any;
}) {
  const cs = await getChangeSet({ pool: params.pool, tenantId: params.tenantId, id: params.changesetId });
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "draft") throw new Error("changeset_not_draft");

  const res = await params.pool.query(
    `
      INSERT INTO governance_changeset_items (changeset_id, kind, payload)
      VALUES ($1,$2,$3)
      RETURNING *
    `,
    [params.changesetId, params.kind, params.payload],
  );
  return toItem(res.rows[0]);
}

export async function submitChangeSet(params: { pool: Pool; tenantId: string; id: string }) {
  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const gate = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items });
  const res = await params.pool.query(
    `
      UPDATE governance_changesets
      SET status = 'submitted',
          submitted_at = now(),
          required_approvals = $3,
          risk_level = $4,
          updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
      RETURNING *
    `,
    [params.tenantId, params.id, gate.requiredApprovals, gate.riskLevel],
  );
  if (!res.rowCount) throw new Error("changeset_submit_failed");
  return toCs(res.rows[0]);
}

export async function approveChangeSet(params: { pool: Pool; tenantId: string; id: string; approvedBy: string }) {
  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT * FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount) throw new Error("changeset_not_found");
    const cs = toCs(locked.rows[0]);
    if (cs.status !== "submitted") throw new Error("changeset_not_submitted");

    await tx.query(
      `
        INSERT INTO governance_changeset_approvals (tenant_id, changeset_id, approved_by)
        VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, changeset_id, approved_by) DO NOTHING
      `,
      [params.tenantId, params.id, params.approvedBy],
    );

    const cntRes = await tx.query(
      `SELECT COUNT(*)::int AS c FROM governance_changeset_approvals WHERE tenant_id = $1 AND changeset_id = $2`,
      [params.tenantId, params.id],
    );
    const approvals = cntRes.rows[0].c as number;

    let out = cs;
    if (approvals >= cs.requiredApprovals) {
      const upd = await tx.query(
        `
          UPDATE governance_changesets
          SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING *
        `,
        [params.tenantId, params.id, params.approvedBy],
      );
      out = toCs(upd.rows[0]);
    }

    await tx.query("COMMIT");
    return { changeset: out, approvals };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

async function validateItem(pool: Pool | PoolClient, tenantId: string, item: ChangeSetItemRow) {
  if (item.kind === "tool.set_active") {
    const toolRef = String(item.payload?.toolRef ?? "");
    const name = String(item.payload?.name ?? "");
    if (!toolRef || !name) throw new Error("invalid_item");
    if (!toolRef.startsWith(`${name}@`)) throw new Error("invalid_item");
    const ver = await getToolVersionByRef(client(pool), tenantId, toolRef);
    if (!ver || ver.status !== "released") throw new Error("tool_version_not_released");
    if (ver.artifactRef) {
      const gate = _validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest);
      if (!gate.trust.ok) throw new Error("trust_not_verified");
      if (!gate.scan.ok) throw new Error("scan_not_passed");
      if (!gate.sbom.ok) throw new Error("sbom_not_present");
      if (gate.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(pool), tenantId });
        if (!runner) throw new Error("isolation_required");
      }
    }
    return;
  }
  if (item.kind === "tool.enable" || item.kind === "tool.disable") {
    const toolRef = String(item.payload?.toolRef ?? "");
    if (!toolRef) throw new Error("invalid_item");
    const ver = await getToolVersionByRef(client(pool), tenantId, toolRef);
    if (!ver || ver.status !== "released") throw new Error("tool_version_not_released");
    if (item.kind === "tool.enable" && ver.artifactRef) {
      const gate = _validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest);
      if (!gate.trust.ok) throw new Error("trust_not_verified");
      if (!gate.scan.ok) throw new Error("scan_not_passed");
      if (!gate.sbom.ok) throw new Error("sbom_not_present");
      if (gate.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(pool), tenantId });
        if (!runner) throw new Error("isolation_required");
      }
    }
    return;
  }
  if (item.kind === "schema.publish") {
    const name = String(item.payload?.name ?? "");
    const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
    if (!name || schemaDef.name !== name) throw new Error("invalid_item");
    const migrationRunId = item.payload?.migrationRunId;
    if (migrationRunId !== undefined && migrationRunId !== null) {
      const v = String(migrationRunId);
      if (!/^[0-9a-fA-F-]{36}$/.test(v)) throw new Error("invalid_item");
    }
    return;
  }
  if (item.kind === "schema.set_active") {
    const name = String(item.payload?.name ?? "");
    const version = Number(item.payload?.version);
    if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const stored = await getByNameVersion(pool as any, name, version);
    if (!stored || stored.status !== "released") throw new Error("invalid_item");
    const migrationRunId = item.payload?.migrationRunId;
    if (migrationRunId !== undefined && migrationRunId !== null) {
      const v = String(migrationRunId);
      if (!/^[0-9a-fA-F-]{36}$/.test(v)) throw new Error("invalid_item");
    }
    return;
  }
  if (item.kind === "schema.rollback") {
    const name = String(item.payload?.name ?? "");
    if (!name) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "ui.page.publish") {
    const pageName = String(item.payload?.pageName ?? "");
    if (!pageName) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "ui.page.rollback") {
    const pageName = String(item.payload?.pageName ?? "");
    if (!pageName) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.version.release") {
    const name = String(item.payload?.name ?? "");
    const version = Number(item.payload?.version);
    if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await getPolicyVersion({ pool: pool as any, tenantId, name, version });
    if (!pv || pv.status !== "draft") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.publish") {
    const policyId = String(item.payload?.policyId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount) throw new Error("invalid_item");
    const st = String(pv.rows[0].status);
    if (!["draft", "submitted", "approved"].includes(st)) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.set_active") {
    const policyId = String(item.payload?.policyId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount || String(pv.rows[0].status) !== "released") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.rollback") {
    const policyId = String(item.payload?.policyId ?? "");
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    const cur = await client(pool).query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [tenantId, policyId]);
    if (!cur.rowCount) throw new Error("invalid_item");
    const prev = await client(pool).query(
      `SELECT version FROM safety_policy_versions WHERE policy_id = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1`,
      [policyId, Number(cur.rows[0].active_version)],
    );
    if (!prev.rowCount) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.set_override") {
    const policyId = String(item.payload?.policyId ?? "");
    const spaceId = String(item.payload?.spaceId ?? "");
    const version = Number(item.payload?.version);
    if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
    if (!spaceId) throw new Error("invalid_item");
    if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
    const pv = await client(pool).query(
      `
        SELECT v.status
        FROM safety_policy_versions v
        JOIN safety_policies p ON p.policy_id = v.policy_id
        WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
        LIMIT 1
      `,
      [tenantId, policyId, version],
    );
    if (!pv.rowCount || String(pv.rows[0].status) !== "released") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "policy.cache.invalidate") {
    const scopeType = String(item.payload?.scopeType ?? "");
    const scopeId = String(item.payload?.scopeId ?? "");
    const reason = String(item.payload?.reason ?? "");
    if (scopeType !== "tenant" && scopeType !== "space") throw new Error("invalid_item");
    if (!scopeId) throw new Error("invalid_item");
    if (!reason || reason.length > 500) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const csScopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const csScopeId = String(csRes.rows[0].scope_id);
    if (scopeType !== csScopeType || scopeId !== csScopeId) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "workbench.plugin.publish") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    if (!workbenchKey) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const draft = await getWorkbenchDraft({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey });
    if (!draft) throw Errors.badRequest("workbench draft 不存在");
    return;
  }
  if (item.kind === "workbench.plugin.rollback") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    if (!workbenchKey) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const cur = await getWorkbenchActiveVersion({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey });
    if (!cur) throw Errors.badRequest("workbench 尚未设置 activeVersion");
    const prev = await getWorkbenchPreviousReleased({ pool: pool as any, tenantId, scopeType, scopeId, workbenchKey, beforeVersion: cur });
    if (!prev) throw Errors.workbenchNoPreviousVersion();
    return;
  }
  if (item.kind === "workbench.plugin.canary") {
    const workbenchKey = String(item.payload?.workbenchKey ?? "");
    const canaryVersion = Number(item.payload?.canaryVersion);
    const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
    if (!workbenchKey) throw new Error("invalid_item");
    if (!Number.isFinite(canaryVersion) || canaryVersion <= 0) throw new Error("invalid_item");
    if (subjectIds.length > 500) throw new Error("invalid_item");
    const csRes = await client(pool).query("SELECT scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      tenantId,
      item.changesetId,
    ]);
    if (!csRes.rowCount) throw new Error("invalid_item");
    const scopeType = csRes.rows[0].scope_type as "tenant" | "space";
    const scopeId = String(csRes.rows[0].scope_id);
    const verRes = await client(pool).query(
      `
        SELECT 1
        FROM workbench_plugin_versions
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released' AND version = $5
        LIMIT 1
      `,
      [tenantId, scopeType, scopeId, workbenchKey, canaryVersion],
    );
    if (!verRes.rowCount) throw Errors.badRequest("workbench canaryVersion 未发布");
    return;
  }
  if (item.kind === "model_routing.upsert") {
    const purpose = String(item.payload?.purpose ?? "");
    const primaryModelRef = String(item.payload?.primaryModelRef ?? "");
    const enabled = item.payload?.enabled === undefined ? true : Boolean(item.payload?.enabled);
    const fallbacks = Array.isArray(item.payload?.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
    if (!purpose || purpose.length > 100) throw new Error("invalid_item");
    if (!primaryModelRef || primaryModelRef.length < 3) throw new Error("invalid_item");
    if (fallbacks.length > 10) throw new Error("invalid_item");
    if (typeof enabled !== "boolean") throw new Error("invalid_item");
    return;
  }
  if (item.kind === "model_routing.disable") {
    const purpose = String(item.payload?.purpose ?? "");
    if (!purpose || purpose.length > 100) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "model_limits.set") {
    return; /* rate limiting removed — kept as no-op for backward compat */
  }
  if (item.kind === "tool_limits.set") {
    const toolRef = String(item.payload?.toolRef ?? "");
    const c = Number(item.payload?.defaultMaxConcurrency);
    if (!toolRef || toolRef.length < 3) throw new Error("invalid_item");
    if (!Number.isFinite(c) || c <= 0 || c > 1000) throw new Error("invalid_item");
    return;
  }
  if (item.kind === "artifact_policy.upsert") {
    const scopeType = String(item.payload?.scopeType ?? "");
    const scopeId = String(item.payload?.scopeId ?? "");
    const expiresInSec = Number(item.payload?.downloadTokenExpiresInSec);
    const maxUses = Number(item.payload?.downloadTokenMaxUses);
    const watermarkHeadersEnabled = item.payload?.watermarkHeadersEnabled;
    if (scopeType !== "tenant" && scopeType !== "space") throw new Error("invalid_item");
    if (!scopeId) throw new Error("invalid_item");
    if (!Number.isFinite(expiresInSec) || expiresInSec <= 0 || expiresInSec > 3600) throw new Error("invalid_item");
    if (!Number.isFinite(maxUses) || maxUses <= 0 || maxUses > 10) throw new Error("invalid_item");
    if (typeof watermarkHeadersEnabled !== "boolean") throw new Error("invalid_item");
    return;
  }
  throw new Error("invalid_item");
}

async function assertMigrationGate(params: { pool: Pool | PoolClient; tenantId: string; migrationRunId: string; schemaName: string; targetVersion: number }) {
  const res = await params.pool.query(
    `
      SELECT r.status, m.schema_name, m.target_version
      FROM schema_migration_runs r
      JOIN schema_migrations m ON m.migration_id = r.migration_id
      WHERE r.tenant_id = $1 AND r.migration_run_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.migrationRunId],
  );
  if (!res.rowCount) throw new Error("migration_required");
  const row = res.rows[0] as any;
  if (String(row.status ?? "") !== "succeeded") throw new Error("migration_required");
  if (String(row.schema_name ?? "") !== params.schemaName) throw new Error("migration_required");
  if (Number(row.target_version ?? 0) !== params.targetVersion) throw new Error("migration_required");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function defaultValueForSchemaType(type: string) {
  const t = String(type ?? "").trim().toLowerCase();
  if (t === "string") return "";
  if (t === "number") return 0;
  if (t === "boolean") return false;
  if (t === "datetime") return new Date(0).toISOString();
  if (t === "json") return null;
  return null;
}

function generateSchemaMigrationDraftsV1(params: {
  scopeType: "tenant" | "space";
  scopeId: string;
  schemaName: string;
  targetVersionHint: number;
  schemaDef: any;
  requiredFieldPaths: string[];
}) {
  const drafts: any[] = [];
  const rollbackPlanSummary = {
    rollbackScope: { scopeType: params.scopeType, scopeId: params.scopeId },
    stopPlan: {
      cancelRun: { method: "POST", path: "/governance/schema-migration-runs/:id/cancel" },
      note: "取消仅停止后续批处理；已写入的数据不自动逆转",
    },
    schemaRollbackPlan: {
      note: "通过 changeset 将 schema active 指针回退到上一 released 版本（或 set_active 指向旧版本）",
      supportedKinds: ["schema.rollback", "schema.set_active"],
    },
    dataRollbackLimitations: "已写入的 payload 字段不保证自动回滚；必要时需另行编写数据修复迁移",
  };

  function resolveFieldType(path: string) {
    const seg = String(path ?? "").split(".").map((s) => s.trim()).filter(Boolean);
    if (seg.length < 2) return null;
    const entityName = seg[0];
    const fieldName = seg.slice(1).join(".");
    const entity = params.schemaDef?.entities?.[entityName];
    const field = entity?.fields?.[fieldName];
    return String(field?.type ?? "").trim() || null;
  }

  for (const p of params.requiredFieldPaths) {
    const seg = String(p ?? "").split(".").map((s) => s.trim()).filter(Boolean);
    if (seg.length < 2) continue;
    const entityName = seg[0];
    const fieldPath = seg.slice(1).join(".");
    const t = resolveFieldType(p);
    drafts.push({
      kind: "backfill_required_field",
      params: { entityName, fieldPath, defaultValue: defaultValueForSchemaType(t ?? ""), batchSize: 200 },
      evidenceDigest: { kind: "backfill_required_field", schemaName: params.schemaName, targetVersion: params.targetVersionHint, entityName, fieldPath },
      rollbackPlanSummary,
      createRequest: {
        method: "POST",
        path: "/governance/schema-migrations",
        body: {
          scopeType: params.scopeType,
          scopeId: params.scopeId,
          schemaName: params.schemaName,
          targetVersion: params.targetVersionHint,
          kind: "backfill_required_field",
          plan: { entityName, fieldPath, defaultValue: defaultValueForSchemaType(t ?? ""), batchSize: 200 },
        },
      },
    });
  }

  const entities = params.schemaDef?.entities ?? {};
  for (const [entityName, entity] of Object.entries<any>(entities)) {
    const fields = entity?.fields ?? {};
    for (const [fieldName, field] of Object.entries<any>(fields)) {
      const ext = field?.extensions;
      const renameFrom = ext && typeof ext === "object" && !Array.isArray(ext) ? (ext as any)?.["io.openslin.migrate"]?.renameFrom : undefined;
      const fromPath = typeof renameFrom === "string" ? renameFrom.trim() : "";
      if (!fromPath) continue;
      const toPath = String(fieldName ?? "").trim();
      if (!toPath) continue;
      drafts.push({
        kind: "rename_field_dual_write",
        params: { entityName, fromPath, toPath },
        evidenceDigest: { kind: "rename_field_dual_write", schemaName: params.schemaName, targetVersion: params.targetVersionHint, entityName, fromPath, toPath },
        rollbackPlanSummary,
        createRequest: {
          method: "POST",
          path: "/governance/schema-migrations",
          body: {
            scopeType: params.scopeType,
            scopeId: params.scopeId,
            schemaName: params.schemaName,
            targetVersion: params.targetVersionHint,
            kind: "rename_field_dual_write",
            plan: { entityName, fromPath, toPath, batchSize: 200 },
          },
        },
      });
    }
  }

  return drafts;
}

async function checkPolicyVersionContract(params: { pool: Pool | PoolClient; tenantId: string; name: string; version: number }) {
  const pv = await getPolicyVersion({ pool: params.pool as any, tenantId: params.tenantId, name: params.name, version: params.version });
  if (!pv) {
    return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": "PolicyVersion 不存在", "en-US": "PolicyVersion not found" }, digest: null };
  }
  const policyJson = pv.policyJson;
  if (!isPlainObject(policyJson)) {
    return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": "policyJson 非对象", "en-US": "policyJson must be an object" }, digest: pv.digest };
  }
  const expr = (policyJson as any).rowFiltersExpr ?? (policyJson as any).policyExpr ?? null;
  if (expr !== null && expr !== undefined) {
    const v = validatePolicyExpr(expr);
    if (!v.ok) {
      return { status: "fail" as const, errorCode: "CONTRACT_NOT_COMPATIBLE", messageI18n: { "zh-CN": v.message, "en-US": v.message }, digest: pv.digest };
    }
  }
  return { status: "pass" as const, errorCode: null, messageI18n: null, digest: pv.digest };
}

export async function preflightChangeSet(params: { pool: Pool; tenantId: string; id: string; mode?: "full" | "canary" }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const gate = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items });
  const approvalsCount = await countApprovals({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const mode = params.mode ?? "full";

  const warnings: string[] = [];
  if (cs.status === "draft") warnings.push("status:draft");
  if (cs.status === "submitted" && approvalsCount < cs.requiredApprovals) warnings.push("approvals:insufficient");
  if (mode === "canary" && (!cs.canaryTargets || cs.canaryTargets.length === 0)) warnings.push("canary_targets:missing");
  if (gate.evalAdmissionRequired) warnings.push("eval_admission:required_by_item_kinds");

  const requiredEvalSuites = await listChangeSetEvalBindings({ pool: params.pool, tenantId: params.tenantId, changesetId: cs.id });
  const evals: any[] = [];
  for (const suiteId of requiredEvalSuites) {
    const suite = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: suiteId });
    if (!suite) {
      warnings.push("evalsuite:missing");
      evals.push({ suiteId, passed: false, latestRunId: null });
      continue;
    }
    const casesJson = Array.isArray(suite.casesJson) ? suite.casesJson : [];
    const digestInput = casesJson.map((c: any) => ({
      caseId: c?.caseId ?? null,
      sourceType: c?.source?.type ?? null,
      toolRef: c?.toolRef ?? null,
      sealStatus: c?.sealStatus ?? null,
      sealedInputDigest: c?.sealedInputDigest ?? null,
      sealedOutputDigest: c?.sealedOutputDigest ?? null,
    }));
    const reportDigest8 = sha256Hex(stableStringify(digestInput)).slice(0, 8);
    const latest = await getLatestEvalRunForChangeSet({ pool: params.pool, tenantId: params.tenantId, suiteId: suite.id, changesetId: cs.id });
    const latestDigest = typeof latest?.summary?.reportDigest8 === "string" ? String(latest.summary.reportDigest8) : "";
    const isStale = Boolean(latest && latestDigest && latestDigest !== reportDigest8);
    const passed = !isStale && latest?.status === "succeeded" && evalPassed({ thresholds: suite.thresholds, summary: latest?.summary });
    if (!passed) warnings.push("eval:not_passed");
    const reason = !latest ? "run:missing" : isStale ? "run:stale" : latest.status !== "succeeded" ? `run:${latest.status}` : passed ? null : "threshold:not_met";
    evals.push({
      suiteId: suite.id,
      name: suite.name,
      passed,
      latestRunId: latest?.id ?? null,
      latestRunStatus: latest?.status ?? null,
      reportDigest8,
      latestReportDigest8: latestDigest || null,
      summary: latest?.summary ?? null,
      reason,
    });
  }

  const plan: any[] = [];
  const currentStateDigest: any[] = [];
  const rollbackPreview: any[] = [];
  const contractChecks: any[] = [];

  const hasNonCanaryItems = items.some(
    (i) => i.kind.startsWith("artifact_policy.") || i.kind.startsWith("ui.") || i.kind.startsWith("workbench.") || i.kind.startsWith("policy."),
  );
  if (mode === "canary" && hasNonCanaryItems) warnings.push("mode:canary_not_supported_for_items");

  const targets = mode === "canary" ? (cs.canaryTargets ?? []) : [];
  for (const item of items) {
    contractChecks.push({ itemId: item.id, kind: item.kind, contractKind: String(item.kind).split(".")[0] ?? "unknown", status: "pass", errorCode: null, messageI18n: null, digest: null });
    if (item.kind === "tool.enable" || item.kind === "tool.disable") {
      const toolRef = String(item.payload.toolRef);
      const enabled = item.kind === "tool.enable";
      const ver = await getToolVersionByRef(client(params.pool), params.tenantId, toolRef);
      const gate = ver?.artifactRef ? _validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest) : null;
      const trust = gate ? gate.trust : { ok: true, status: "n/a" as const };
      const scan = gate ? gate.scan : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      const sbom = gate ? gate.sbom : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      let isolationOk = true;
      if (enabled && ver?.artifactRef && gate?.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(params.pool), tenantId: params.tenantId });
        isolationOk = Boolean(runner);
      }
      if (enabled && ver?.artifactRef) {
        if (!trust.ok) warnings.push("tool_trust:not_verified");
        if (!scan.ok) warnings.push("tool_scan:not_passed");
        if (!sbom.ok) warnings.push("tool_sbom:not_present");
        if (!isolationOk) warnings.push("tool_isolation:not_satisfied");
      }

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getToolRolloutEnabled({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
          plan.push({
            kind: item.kind,
            scopeType: "space",
            scopeId: spaceId,
            toolRef,
            hasArtifact: Boolean(ver?.artifactRef),
            trustStatus: trust.status,
            scanMode: scan.mode,
            scanStatus: scan.status,
            sbomMode: (sbom as any).mode ?? null,
            sbomStatus: (sbom as any).status ?? null,
            isolationOk,
          });
          currentStateDigest.push({ kind: "tool.enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
          rollbackPreview.push({ kind: "tool.set_enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
        }
      } else {
        const prev = await getToolRolloutEnabled({ pool: params.pool, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
        plan.push({
          kind: item.kind,
          scopeType: cs.scopeType,
          scopeId: cs.scopeId,
          toolRef,
          hasArtifact: Boolean(ver?.artifactRef),
          trustStatus: trust.status,
          scanMode: scan.mode,
          scanStatus: scan.status,
          sbomMode: (sbom as any).mode ?? null,
          sbomStatus: (sbom as any).status ?? null,
          isolationOk,
        });
        currentStateDigest.push({ kind: "tool.enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
        rollbackPreview.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
      }
      continue;
    }

    if (item.kind === "tool.set_active") {
      const toolRef = String(item.payload.toolRef);
      const name = String(item.payload.name);
      const ver = await getToolVersionByRef(client(params.pool), params.tenantId, toolRef);
      const gate = ver?.artifactRef ? _validateToolSupplyChain((ver as any).trustSummary, (ver as any).scanSummary, (ver as any).sbomSummary, (ver as any).sbomDigest) : null;
      const trust = gate ? gate.trust : { ok: true, status: "n/a" as const };
      const scan = gate ? gate.scan : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      const sbom = gate ? gate.sbom : { ok: true, mode: "n/a" as const, status: "n/a" as const };
      let isolationOk = true;
      if (ver?.artifactRef && gate?.isolation.denied) {
        const override = String(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT ?? "").trim();
        const runner = override ? { endpoint: override } : await getEnabledSkillRuntimeRunner({ pool: client(params.pool), tenantId: params.tenantId });
        isolationOk = Boolean(runner);
      }
      if (ver?.artifactRef) {
        if (!trust.ok) warnings.push("tool_trust:not_verified");
        if (!scan.ok) warnings.push("tool_scan:not_passed");
        if (!sbom.ok) warnings.push("tool_sbom:not_present");
        if (!isolationOk) warnings.push("tool_isolation:not_satisfied");
      }

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getActiveToolOverride({ pool: params.pool, tenantId: params.tenantId, spaceId, name });
          plan.push({
            kind: item.kind,
            scopeType: "space",
            scopeId: spaceId,
            name,
            toolRef,
            hasArtifact: Boolean(ver?.artifactRef),
            trustStatus: trust.status,
            scanMode: scan.mode,
            scanStatus: scan.status,
            sbomMode: (sbom as any).mode ?? null,
            sbomStatus: (sbom as any).status ?? null,
            isolationOk,
          });
          currentStateDigest.push({ kind: "tool.active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
          rollbackPreview.push({ kind: "tool.set_active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
        }
      } else {
        const prev = await getActiveToolRef({ pool: params.pool, tenantId: params.tenantId, name });
        plan.push({
          kind: item.kind,
          scopeType: "tenant",
          scopeId: params.tenantId,
          name,
          toolRef,
          hasArtifact: Boolean(ver?.artifactRef),
          trustStatus: trust.status,
          scanMode: scan.mode,
          scanStatus: scan.status,
          sbomMode: (sbom as any).mode ?? null,
          sbomStatus: (sbom as any).status ?? null,
          isolationOk,
        });
        currentStateDigest.push({ kind: "tool.active", name, toolRef: prev?.activeToolRef ?? null });
        rollbackPreview.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
      }
      continue;
    }

    if (item.kind === "schema.publish") {
      const schemaName = String(item.payload?.name ?? "");
      const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
      const latest = await client(params.pool).query(
        "SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1",
        [schemaName],
      );
      const nextVersionHint = (latest.rowCount ? Number(latest.rows[0].version) : 0) + 1;

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
          const requiresMigration = compatReport.level === "migration_required";
          const requiredPaths = Array.from(
            new Set([...compatReport.diffSummary.required.addedPaths, ...compatReport.diffSummary.required.upgradedPaths]),
          );
          const migrationDrafts = requiresMigration
            ? generateSchemaMigrationDraftsV1({
                scopeType: "space",
                scopeId: spaceId,
                schemaName,
                targetVersionHint: nextVersionHint,
                schemaDef,
                requiredFieldPaths: requiredPaths,
              })
            : generateSchemaMigrationDraftsV1({
                scopeType: "space",
                scopeId: spaceId,
                schemaName,
                targetVersionHint: nextVersionHint,
                schemaDef,
                requiredFieldPaths: [],
              }).filter((d: any) => d.kind === "rename_field_dual_write");
          const admission = {
            decision: compatReport.level === "compatible" ? ("allow_release" as const) : ("block_release" as const),
            blockedReasons:
              compatReport.level === "breaking"
                ? ["SCHEMA_BREAKING_CHANGE"]
                : compatReport.level === "migration_required"
                  ? ["SCHEMA_MIGRATION_REQUIRED"]
                  : [],
          };
          if (compatReport.level === "breaking") warnings.push("schema_compat:failed");
          if (requiresMigration) warnings.push("migration:required");
          plan.push({
            kind: item.kind,
            scopeType: "space",
            scopeId: spaceId,
            schemaName,
            nextVersionHint,
            compatReport,
            admission,
            compatOk: compatReport.level !== "breaking",
            requiresMigration,
            migrationDrafts,
            migrationPlanDigest: requiresMigration
              ? {
                  kind: "backfill_required_field",
                  targetVersion: nextVersionHint,
                  requiredAddedFields: compatReport.diffSummary.required.addedPaths,
                  requiredUpgradedFields: compatReport.diffSummary.required.upgradedPaths,
                  compatReportDigest8: compatReport.digest.sha256_8,
                }
              : null,
          });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: prev?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
        const requiresMigration = compatReport.level === "migration_required";
        const scopeType = cs.scopeType;
        const scopeId = cs.scopeId;
        const requiredPaths = Array.from(new Set([...compatReport.diffSummary.required.addedPaths, ...compatReport.diffSummary.required.upgradedPaths]));
        const migrationDrafts = requiresMigration
          ? generateSchemaMigrationDraftsV1({ scopeType, scopeId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: requiredPaths })
          : generateSchemaMigrationDraftsV1({ scopeType, scopeId, schemaName, targetVersionHint: nextVersionHint, schemaDef, requiredFieldPaths: [] }).filter(
              (d: any) => d.kind === "rename_field_dual_write",
            );
        const admission = {
          decision: compatReport.level === "compatible" ? ("allow_release" as const) : ("block_release" as const),
          blockedReasons:
            compatReport.level === "breaking"
              ? ["SCHEMA_BREAKING_CHANGE"]
              : compatReport.level === "migration_required"
                ? ["SCHEMA_MIGRATION_REQUIRED"]
                : [],
        };
        if (compatReport.level === "breaking") warnings.push("schema_compat:failed");
        if (requiresMigration) warnings.push("migration:required");
        plan.push({
          kind: item.kind,
          scopeType: cs.scopeType,
          scopeId: cs.scopeId,
          schemaName,
          nextVersionHint,
          compatReport,
          admission,
          compatOk: compatReport.level !== "breaking",
          requiresMigration,
          migrationDrafts,
          migrationPlanDigest: requiresMigration
            ? {
                kind: "backfill_required_field",
                targetVersion: nextVersionHint,
                requiredAddedFields: compatReport.diffSummary.required.addedPaths,
                requiredUpgradedFields: compatReport.diffSummary.required.upgradedPaths,
                compatReportDigest8: compatReport.digest.sha256_8,
              }
            : null,
        });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: prev?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
      }
      continue;
    }

    if (item.kind === "schema.set_active") {
      const schemaName = String(item.payload?.name ?? "");
      const version = Number(item.payload?.version);
      const stored = Number.isFinite(version) ? await getByNameVersion(params.pool as any, schemaName, version) : null;
      if (!stored || stored.status !== "released") warnings.push("schema_version:missing");

      if (mode === "canary") {
        for (const spaceId of targets) {
          const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, schemaName, version });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: prev?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const prev = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: prev?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
      }
      continue;
    }

    if (item.kind === "schema.rollback") {
      const schemaName = String(item.payload?.name ?? "");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const cur = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
          const prevVersion = cur ? await getPreviousReleasedSchemaVersion({ pool: params.pool, name: schemaName, beforeVersion: cur.version }) : null;
          if (!prevVersion) warnings.push("schema_prev:missing");
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, schemaName, toVersion: prevVersion });
          currentStateDigest.push({ kind: "schema.effective", scopeType: "space", scopeId: spaceId, schemaName, version: cur?.version ?? null });
          rollbackPreview.push({ kind: "schema.set_active_override", spaceId, schemaName, version: cur?.version ?? null });
        }
      } else {
        const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
        const cur = await getEffectiveSchema({ pool: params.pool, tenantId: params.tenantId, spaceId, name: schemaName });
        const prevVersion = cur ? await getPreviousReleasedSchemaVersion({ pool: params.pool, name: schemaName, beforeVersion: cur.version }) : null;
        if (!prevVersion) warnings.push("schema_prev:missing");
        plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, toVersion: prevVersion });
        currentStateDigest.push({ kind: "schema.effective", scopeType: cs.scopeType, scopeId: cs.scopeId, schemaName, version: cur?.version ?? null });
        rollbackPreview.push({ kind: "schema.set_active", schemaName, version: cur?.version ?? null });
      }
      continue;
    }

    if (item.kind === "ui.page.publish") {
      const pageName = String(item.payload?.pageName ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
      const cur = await getLatestReleasedPage(params.pool, key);
      const draft = await getPageDraft(params.pool, key);
      const actionBindings = Array.isArray(draft?.actionBindings) ? draft?.actionBindings : [];
      const dataBindings = Array.isArray(draft?.dataBindings) ? draft?.dataBindings : [];
      const toolRefs = Array.from(new Set(actionBindings.map((x: any) => String(x?.toolRef ?? "")).filter(Boolean))).sort();
      const referencedToolRefsDigest = sha256Hex(JSON.stringify(toolRefs));
      let status: "pass" | "fail" | "warn" = "pass";
      let errorCode: string | null = null;
      let messageI18n: any = null;
      if (!draft) {
        status = "fail";
        errorCode = "CONTRACT_NOT_COMPATIBLE";
        messageI18n = { "zh-CN": "UI 页面 draft 不存在", "en-US": "UI page draft missing" };
      } else {
        for (const ref of toolRefs) {
          const v = await getToolVersionByRef(params.pool as any, params.tenantId, ref);
          if (!v || v.status !== "released") {
            status = "fail";
            errorCode = "CONTRACT_NOT_COMPATIBLE";
            messageI18n = { "zh-CN": "UI 页面引用的工具版本未发布", "en-US": "Referenced tool version not released" };
            break;
          }
        }
        if (status !== "fail") {
          for (const a of actionBindings) {
            const rawToolRef = String((a as any)?.toolRef ?? "");
            if (!rawToolRef) continue;
            const at = rawToolRef.lastIndexOf("@");
            const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
            const def = await getToolDefinition(params.pool as any, params.tenantId, toolName);
            if (!def) {
              status = "fail";
              errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面引用的工具契约缺失", "en-US": "Referenced tool contract missing" };
              break;
            }
            const idempotencyRequired = Boolean(def.idempotencyRequired);
            const approvalRequired = Boolean(def.approvalRequired) || def.riskLevel === "high";
            if (idempotencyRequired && String((a as any)?.idempotencyKeyStrategy ?? "") !== "required") {
              status = "fail";
              errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面 ActionBinding 缺少幂等键策略", "en-US": "UI page ActionBinding missing idempotency key strategy" };
              break;
            }
            if (approvalRequired && String((a as any)?.approval ?? "") !== "required") {
              status = "fail";
              errorCode = "CONTRACT_NOT_COMPATIBLE";
              messageI18n = { "zh-CN": "UI 页面 ActionBinding 缺少审批声明", "en-US": "UI page ActionBinding missing approval declaration" };
              break;
            }
            if (approvalRequired) {
              const cm = (a as any)?.confirmMessage;
              const hasZh = cm && typeof cm === "object" && String(cm["zh-CN"] ?? "").trim().length > 0;
              const hasEn = cm && typeof cm === "object" && String(cm["en-US"] ?? "").trim().length > 0;
              if (!hasZh && !hasEn) {
                status = "fail";
                errorCode = "CONTRACT_NOT_COMPATIBLE";
                messageI18n = { "zh-CN": "高风险 ActionBinding 缺少 confirmMessage", "en-US": "High-risk ActionBinding missing confirmMessage" };
                break;
              }
            }
          }
        }
      }
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "workflow", status, errorCode, messageI18n, digest: referencedToolRefsDigest };
      if (status === "fail") warnings.push("contract:not_compatible");

      plan.push({
        kind: item.kind,
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        pageName,
        currentReleasedVersion: cur?.version ?? null,
        dataBindingsCount: dataBindings.length,
        actionBindingsCount: actionBindings.length,
        referencedToolRefsCount: toolRefs.length,
        referencedToolRefsDigest,
      });
      currentStateDigest.push({ kind: "ui.page", pageName, currentReleasedVersion: cur?.version ?? null, hasDraft: Boolean(draft) });
      rollbackPreview.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null });
      continue;
    }

    if (item.kind === "ui.page.rollback") {
      const pageName = String(item.payload?.pageName ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
      const cur = await getLatestReleasedPage(params.pool, key);
      const prevExists = cur ? true : false;
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, pageName, currentReleasedVersion: cur?.version ?? null });
      currentStateDigest.push({ kind: "ui.page", pageName, currentReleasedVersion: cur?.version ?? null });
      rollbackPreview.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, prevExists });
      continue;
    }

    if (item.kind === "policy.cache.invalidate") {
      const reason = String(item.payload?.reason ?? "");
      const currentEpoch = await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId });
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, previousEpoch: currentEpoch, reasonLen: reason.length });
      currentStateDigest.push({ kind: "policy.cache.epoch", scopeType: cs.scopeType, scopeId: cs.scopeId, epoch: currentEpoch });
      rollbackPreview.push({ kind: "policy.cache.invalidate", scopeType: cs.scopeType, scopeId: cs.scopeId, nonReversible: true });
      continue;
    }
    if (item.kind === "policy.version.release") {
      const name = String(item.payload?.name ?? "");
      const version = Number(item.payload?.version);
      const cc = await checkPolicyVersionContract({ pool: params.pool, tenantId: params.tenantId, name, version });
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "policy", status: cc.status, errorCode: cc.errorCode, messageI18n: cc.messageI18n, digest: cc.digest };
      if (cc.status === "fail") warnings.push("contract:not_compatible");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, name, version, contractStatus: cc.status });
      currentStateDigest.push({ kind: "policy.version", name, active: null });
      rollbackPreview.push({ kind: "policy.version.restore", name, version, restoreStatus: "draft" });
      continue;
    }

    if (item.kind === "policy.publish") {
      const policyId = String(item.payload?.policyId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, version });
      currentStateDigest.push({ kind: "safety_policy.version", policyId, version, status: "draft" });
      rollbackPreview.push({ kind: "safety_policy.version.restore", policyId, version, restoreStatus: "draft" });
      continue;
    }
    if (item.kind === "policy.set_active") {
      const policyId = String(item.payload?.policyId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, version });
      currentStateDigest.push({ kind: "safety_policy.active", policyId, scopeType: cs.scopeType, scopeId: cs.scopeId, version });
      rollbackPreview.push({ kind: "safety_policy.set_active", policyId, version: null });
      continue;
    }
    if (item.kind === "policy.rollback") {
      const policyId = String(item.payload?.policyId ?? "");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId });
      currentStateDigest.push({ kind: "safety_policy.active", policyId, scopeType: cs.scopeType, scopeId: cs.scopeId });
      rollbackPreview.push({ kind: "safety_policy.rollback", policyId, nonReversible: false });
      continue;
    }
    if (item.kind === "policy.set_override") {
      const policyId = String(item.payload?.policyId ?? "");
      const spaceId = String(item.payload?.spaceId ?? "");
      const version = Number(item.payload?.version);
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, policyId, spaceId, version });
      currentStateDigest.push({ kind: "safety_policy.active_override", policyId, spaceId, version });
      rollbackPreview.push({ kind: "safety_policy.set_override", policyId, spaceId, version: null });
      continue;
    }

    if (item.kind === "workbench.plugin.publish") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const draft = await getWorkbenchDraft({ pool: params.pool as any, ...key });
      const latest = await getWorkbenchLatestReleased({ pool: params.pool as any, ...key });
      const active = await getWorkbenchActiveVersion({ pool: params.pool as any, ...key });
      const nextVersion = (latest?.version ?? 0) + 1;
      const manifest = draft?.manifestJson ?? null;
      const caps = manifest && typeof manifest === "object" ? (manifest as any).capabilities : null;
      const dataBindingsCount = Array.isArray(caps?.dataBindings) ? caps.dataBindings.length : 0;
      const actionBindingsCount = Array.isArray(caps?.actionBindings) ? caps.actionBindings.length : 0;
      const capabilitiesSummary = { dataBindingsCount, actionBindingsCount, sha256_8: sha256Hex(JSON.stringify({ dataBindingsCount, actionBindingsCount })).slice(0, 8) };
      const riskHints = { containsActions: actionBindingsCount > 0, hasDraft: Boolean(draft) };
      if (!draft) {
        contractChecks[contractChecks.length - 1] = {
          ...contractChecks[contractChecks.length - 1],
          contractKind: "workflow",
          status: "fail",
          errorCode: "CONTRACT_NOT_COMPATIBLE",
          messageI18n: { "zh-CN": "Workbench draft 不存在", "en-US": "Workbench draft missing" },
          digest: null,
        };
        warnings.push("contract:not_compatible");
      } else {
        let status: "pass" | "fail" | "warn" = "pass";
        let errorCode: string | null = null;
        let messageI18n: any = null;
        const actionCaps = Array.isArray(caps?.actionBindings) ? caps.actionBindings : [];
        for (const c of actionCaps) {
          const kind = String((c as any)?.kind ?? "");
          if (kind !== "tools.invoke") continue;
          const allow = (c as any)?.allow;
          const toolRefs = Array.isArray(allow?.toolRefs) ? allow.toolRefs : null;
          const toolNames = Array.isArray(allow?.toolNames) ? allow.toolNames : null;
          if ((!toolRefs || toolRefs.length === 0) && (!toolNames || toolNames.length === 0)) {
            status = "fail";
            errorCode = "CONTRACT_NOT_COMPATIBLE";
            messageI18n = { "zh-CN": "Workbench tools.invoke 缺少工具 allowlist", "en-US": "Workbench tools.invoke missing tool allowlist" };
            break;
          }
        }
        contractChecks[contractChecks.length - 1] = {
          ...contractChecks[contractChecks.length - 1],
          contractKind: "workflow",
          status,
          errorCode,
          messageI18n,
          digest: (draft as any).manifestDigest ?? null,
        };
        if (status === "fail") warnings.push("contract:not_compatible");
      }
      plan.push({
        kind: item.kind,
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        workbenchKey,
        fromActiveVersion: active ?? null,
        toVersion: draft ? nextVersion : null,
        manifestDigest: draft?.manifestDigest ?? null,
        capabilitiesSummary,
        riskHints,
      });
      currentStateDigest.push({
        kind: "workbench",
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        workbenchKey,
        activeVersion: active ?? null,
        latestReleasedVersion: latest?.version ?? null,
        hasDraft: Boolean(draft),
      });
      rollbackPreview.push({ kind: "workbench.set_active", workbenchKey, restoreToVersion: active ?? null });
      if (!draft) warnings.push("workbench_draft:missing");
      continue;
    }

    if (item.kind === "workbench.plugin.rollback") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const active = await getWorkbenchActiveVersion({ pool: params.pool as any, ...key });
      const prev = active ? await getWorkbenchPreviousReleased({ pool: params.pool as any, ...key, beforeVersion: active }) : null;
      if (!active) warnings.push("workbench_active:missing");
      if (!prev) warnings.push("workbench_prev:missing");
      plan.push({ kind: item.kind, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, fromActiveVersion: active ?? null, toVersion: prev ?? null });
      currentStateDigest.push({ kind: "workbench", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, activeVersion: active ?? null });
      rollbackPreview.push({ kind: "workbench.set_active", workbenchKey, restoreToVersion: active ?? null });
      continue;
    }

    if (item.kind === "workbench.plugin.canary") {
      const workbenchKey = String(item.payload?.workbenchKey ?? "");
      const canaryVersion = Number(item.payload?.canaryVersion);
      const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
      const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
      const prev = await getWorkbenchCanaryConfig({ pool: params.pool as any, ...key });
      plan.push({
        kind: item.kind,
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        workbenchKey,
        canaryVersion,
        subjectCount: subjectIds.length,
        prevCanaryVersion: prev?.canaryVersion ?? null,
      });
      currentStateDigest.push({
        kind: "workbench.canary",
        scopeType: cs.scopeType,
        scopeId: cs.scopeId,
        workbenchKey,
        prevCanaryVersion: prev?.canaryVersion ?? null,
        prevSubjectCount: prev?.canarySubjectIds.length ?? 0,
      });
      rollbackPreview.push({ kind: "workbench.set_canary", workbenchKey, restorePrev: prev ? { canaryVersion: prev.canaryVersion, subjectCount: prev.canarySubjectIds.length } : null });
      continue;
    }

    if (item.kind === "model_routing.upsert") {
      const purpose = String(item.payload?.purpose ?? "");
      const primaryModelRef = String(item.payload?.primaryModelRef ?? "");
      const fallbackModelRefs = Array.isArray(item.payload?.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
      const enabled = item.payload?.enabled === undefined ? true : Boolean(item.payload?.enabled);
      const refs = [primaryModelRef, ...fallbackModelRefs].map((x) => String(x ?? "").trim()).filter(Boolean);
      let status: "pass" | "fail" | "warn" = "pass";
      let errorCode: string | null = null;
      let messageI18n: any = null;
      for (const ref of refs) {
        const m = /^([a-z0-9_]+):(.+)$/.exec(ref);
        if (!m) {
          status = "fail";
          errorCode = "CONTRACT_NOT_COMPATIBLE";
          messageI18n = { "zh-CN": "无效 modelRef", "en-US": "Invalid modelRef" };
          break;
        }
        const provider = m[1];
        if (!isSupportedModelProvider(provider)) {
          status = "fail";
          errorCode = "CONTRACT_NOT_COMPATIBLE";
          messageI18n = { "zh-CN": "provider 未实现", "en-US": "Provider not implemented" };
          break;
        }
        const bRes =
          mode === "canary"
            ? await client(params.pool).query(
                `SELECT 1
                 FROM provider_bindings
                 WHERE tenant_id = $1
                   AND provider = $2
                   AND status = 'active'
                   AND (
                     (scope_type = 'tenant' AND scope_id = $3)
                     OR (scope_type = 'space' AND scope_id = ANY($4::text[]))
                   )
                 LIMIT 1`,
                [params.tenantId, provider, params.tenantId, targets],
              )
            : await client(params.pool).query(
                `SELECT 1
                 FROM provider_bindings
                 WHERE tenant_id = $1
                   AND provider = $2
                   AND status = 'active'
                   AND (
                     (scope_type = $3 AND scope_id = $4)
                     OR (scope_type = 'tenant' AND scope_id = $1)
                   )
                 LIMIT 1`,
                [params.tenantId, provider, cs.scopeType, cs.scopeId],
              );
        if (!bRes.rowCount) {
          status = "fail";
          errorCode = "CONTRACT_NOT_COMPATIBLE";
          messageI18n = { "zh-CN": "未配置 provider binding", "en-US": "Provider binding missing" };
          break;
        }
      }
      contractChecks[contractChecks.length - 1] = { ...contractChecks[contractChecks.length - 1], contractKind: "model", status, errorCode, messageI18n };
      if (status === "fail") warnings.push("contract:not_compatible");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const prevOvrRes = await client(params.pool).query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`,
            [params.tenantId, spaceId, purpose],
          );
          const prevBaseRes = await client(params.pool).query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
            [params.tenantId, purpose],
          );
          const prevBase = prevBaseRes.rowCount
            ? {
                primaryModelRef: prevBaseRes.rows[0].primary_model_ref,
                fallbackCount: Array.isArray(prevBaseRes.rows[0].fallback_model_refs) ? prevBaseRes.rows[0].fallback_model_refs.length : 0,
                enabled: Boolean(prevBaseRes.rows[0].enabled),
              }
            : null;
          const prevOverride = prevOvrRes.rowCount
            ? {
                primaryModelRef: prevOvrRes.rows[0].primary_model_ref,
                fallbackCount: Array.isArray(prevOvrRes.rows[0].fallback_model_refs) ? prevOvrRes.rows[0].fallback_model_refs.length : 0,
                enabled: Boolean(prevOvrRes.rows[0].enabled),
              }
            : null;
          const prevEff = prevOverride ?? prevBase;
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, purpose, primaryModelRef, fallbackCount: fallbackModelRefs.length, enabled });
          currentStateDigest.push({ kind: "model.routing_policy", scopeType: "space", scopeId: spaceId, purpose, exists: Boolean(prevEff), prev: prevEff, overrideExists: Boolean(prevOverride) });
          rollbackPreview.push({ kind: "model_routing.override_restore", spaceId, purpose, exists: Boolean(prevOverride) });
        }
      } else {
        const prevRes = await client(params.pool).query(
          `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
          [params.tenantId, purpose],
        );
        const prev = prevRes.rowCount
          ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevRes.rows[0].enabled) }
          : null;
        plan.push({ kind: item.kind, purpose, primaryModelRef, fallbackCount: fallbackModelRefs.length, enabled });
        currentStateDigest.push({ kind: "model.routing_policy", purpose, exists: Boolean(prev), prev });
        rollbackPreview.push({ kind: "model_routing.restore", purpose, exists: Boolean(prev) });
      }
      continue;
    }

    if (item.kind === "model_routing.disable") {
      const purpose = String(item.payload?.purpose ?? "");
      if (mode === "canary") {
        for (const spaceId of targets) {
          const prevOvrRes = await client(params.pool).query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`,
            [params.tenantId, spaceId, purpose],
          );
          const prevBaseRes = await client(params.pool).query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
            [params.tenantId, purpose],
          );
          const prevBase = prevBaseRes.rowCount
            ? {
                primaryModelRef: prevBaseRes.rows[0].primary_model_ref,
                fallbackCount: Array.isArray(prevBaseRes.rows[0].fallback_model_refs) ? prevBaseRes.rows[0].fallback_model_refs.length : 0,
                enabled: Boolean(prevBaseRes.rows[0].enabled),
              }
            : null;
          const prevOverride = prevOvrRes.rowCount
            ? {
                primaryModelRef: prevOvrRes.rows[0].primary_model_ref,
                fallbackCount: Array.isArray(prevOvrRes.rows[0].fallback_model_refs) ? prevOvrRes.rows[0].fallback_model_refs.length : 0,
                enabled: Boolean(prevOvrRes.rows[0].enabled),
              }
            : null;
          const prevEff = prevOverride ?? prevBase;
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, purpose });
          currentStateDigest.push({ kind: "model.routing_policy", scopeType: "space", scopeId: spaceId, purpose, exists: Boolean(prevEff), prev: prevEff, overrideExists: Boolean(prevOverride) });
          rollbackPreview.push({ kind: "model_routing.override_restore", spaceId, purpose, exists: Boolean(prevOverride) });
        }
      } else {
        const prevRes = await client(params.pool).query(
          `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
          [params.tenantId, purpose],
        );
        const prev = prevRes.rowCount
          ? { primaryModelRef: prevRes.rows[0].primary_model_ref, fallbackCount: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs.length : 0, enabled: Boolean(prevRes.rows[0].enabled) }
          : null;
        plan.push({ kind: item.kind, purpose });
        currentStateDigest.push({ kind: "model.routing_policy", purpose, exists: Boolean(prev), prev });
        rollbackPreview.push({ kind: "model_routing.restore", purpose, exists: Boolean(prev) });
      }
      continue;
    }

    if (item.kind === "model_limits.set") {
      /* rate limiting removed — skip */
      continue;
    }

    if (item.kind === "tool_limits.set") {
      const toolRef = String(item.payload?.toolRef ?? "");
      const defaultMaxConcurrency = Number(item.payload?.defaultMaxConcurrency);
      if (mode === "canary") {
        for (const spaceId of targets) {
          const prevOvrRes = await client(params.pool).query(
            `SELECT default_max_concurrency FROM tool_limits_overrides WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3 LIMIT 1`,
            [params.tenantId, spaceId, toolRef],
          );
          const prevBaseRes = await client(params.pool).query(
            `SELECT default_max_concurrency FROM tool_limits WHERE tenant_id = $1 AND tool_ref = $2 LIMIT 1`,
            [params.tenantId, toolRef],
          );
          const prevBase = prevBaseRes.rowCount ? { defaultMaxConcurrency: Number(prevBaseRes.rows[0].default_max_concurrency) } : null;
          const prevOverride = prevOvrRes.rowCount ? { defaultMaxConcurrency: Number(prevOvrRes.rows[0].default_max_concurrency) } : null;
          const prevEff = prevOverride ?? prevBase;
          plan.push({ kind: item.kind, scopeType: "space", scopeId: spaceId, toolRef, defaultMaxConcurrency });
          currentStateDigest.push({ kind: "tool.limit", scopeType: "space", scopeId: spaceId, toolRef, exists: Boolean(prevEff), prev: prevEff, overrideExists: Boolean(prevOverride) });
          rollbackPreview.push({ kind: "tool_limits.override_restore", spaceId, toolRef, exists: Boolean(prevOverride) });
        }
      } else {
        const prevRes = await client(params.pool).query(
          `SELECT default_max_concurrency FROM tool_limits WHERE tenant_id = $1 AND tool_ref = $2 LIMIT 1`,
          [params.tenantId, toolRef],
        );
        const prev = prevRes.rowCount ? { defaultMaxConcurrency: Number(prevRes.rows[0].default_max_concurrency) } : null;
        plan.push({ kind: item.kind, toolRef, defaultMaxConcurrency });
        currentStateDigest.push({ kind: "tool.limit", toolRef, exists: Boolean(prev), prev });
        rollbackPreview.push({ kind: "tool_limits.restore", toolRef, exists: Boolean(prev) });
      }
      continue;
    }

    if (item.kind === "artifact_policy.upsert") {
      const scopeType = String(item.payload?.scopeType ?? "") as "tenant" | "space";
      const scopeId = String(item.payload?.scopeId ?? "");
      const downloadTokenExpiresInSec = Number(item.payload?.downloadTokenExpiresInSec);
      const downloadTokenMaxUses = Number(item.payload?.downloadTokenMaxUses);
      const watermarkHeadersEnabled = Boolean(item.payload?.watermarkHeadersEnabled);
      const prevRes = await client(params.pool).query(
        `SELECT download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 LIMIT 1`,
        [params.tenantId, scopeType, scopeId],
      );
      const prev = prevRes.rowCount
        ? {
            scopeType,
            scopeId,
            downloadTokenExpiresInSec: Number(prevRes.rows[0].download_token_expires_in_sec),
            downloadTokenMaxUses: Number(prevRes.rows[0].download_token_max_uses),
            watermarkHeadersEnabled: Boolean(prevRes.rows[0].watermark_headers_enabled),
          }
        : null;
      plan.push({ kind: item.kind, scopeType, scopeId, downloadTokenExpiresInSec, downloadTokenMaxUses, watermarkHeadersEnabled });
      currentStateDigest.push({ kind: "artifact.policy", scopeType, scopeId, exists: Boolean(prev), prev });
      rollbackPreview.push({ kind: "artifact_policy.restore", scopeType, scopeId, exists: Boolean(prev) });
      continue;
    }
  }

  return {
    changeset: cs,
    gate: { riskLevel: gate.riskLevel, requiredApprovals: gate.requiredApprovals, approvalsCount },
    evalGate: { requiredSuiteIds: requiredEvalSuites, suites: evals, evalAdmissionRequired: gate.evalAdmissionRequired },
    plan,
    currentStateDigest,
    rollbackPreview,
    contractChecks,
    warnings,
  };
}

export async function releaseChangeSet(params: { pool: Pool; tenantId: string; id: string; releasedBy: string; mode?: "full" | "canary" }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "approved") throw new Error("changeset_not_approved");

  const mode = params.mode ?? "full";
  const targets = mode === "canary" ? (cs.canaryTargets ?? []) : [];
  if (mode === "canary" && targets.length === 0) throw new Error("canary_targets_missing");

  const items2 = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const gate2 = await computeApprovalGate({ pool: params.pool, tenantId: params.tenantId, items: items2 });
  const requiredEvalSuites = await listChangeSetEvalBindings({ pool: params.pool, tenantId: params.tenantId, changesetId: cs.id });
  const isHighRisk = cs.riskLevel === "high" || cs.requiredApprovals >= 2;
  // Block release if eval-admission-required kinds exist but no suites are bound
  if (gate2.evalAdmissionRequired && requiredEvalSuites.length === 0) {
    throw new Error("eval_not_passed");
  }
  if ((isHighRisk || gate2.evalAdmissionRequired) && requiredEvalSuites.length) {
    for (const suiteId of requiredEvalSuites) {
      const suite = await getEvalSuite({ pool: params.pool, tenantId: params.tenantId, id: suiteId });
      if (!suite) throw new Error("eval_not_passed");
      const latest = await getLatestEvalRunForChangeSet({ pool: params.pool, tenantId: params.tenantId, suiteId: suite.id, changesetId: cs.id });
      const passed = latest?.status === "succeeded" && evalPassed({ thresholds: suite.thresholds, summary: latest?.summary });
      if (!passed) throw new Error("eval_not_passed");
    }
  }

  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  if (
    mode === "canary" &&
    items.some(
      (i) =>
        i.kind.startsWith("artifact_policy.") ||
        i.kind.startsWith("ui.") ||
        i.kind.startsWith("workbench.") ||
        i.kind.startsWith("policy."),
    )
  ) {
    throw new Error("changeset_mode_not_supported");
  }
  const rollback: any = { actions: [] as any[], schemaPublishedVersions: {} as Record<string, number> };

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT status FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount || locked.rows[0].status !== "approved") throw new Error("changeset_not_approved");

    const approvals = await countApprovals({ pool: tx, tenantId: params.tenantId, changesetId: params.id });
    if (approvals < cs.requiredApprovals) throw new Error("changeset_insufficient_approvals");

    for (const item of items) {
      await validateItem(tx, params.tenantId, item);

      if (item.kind === "tool.enable" || item.kind === "tool.disable") {
        const toolRef = String(item.payload.toolRef);
        const enabled = item.kind === "tool.enable";

        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
            rollback.actions.push({ kind: "tool.set_enabled", scopeType: "space", scopeId: spaceId, toolRef, enabled: prev });
            await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef, enabled });
          }
        } else {
          const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
          rollback.actions.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
          await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled });
        }
        continue;
      }

      if (item.kind === "tool.set_active") {
        const toolRef = String(item.payload.toolRef);
        const name = String(item.payload.name);

        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
            rollback.actions.push({ kind: "tool.set_active_override", spaceId, name, toolRef: prev?.activeToolRef ?? null });
            await setActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name, toolRef });
          }
        } else {
          const prev = await getActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
          rollback.actions.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
          await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });
        }
        continue;
      }

      if (item.kind === "schema.publish") {
        const schemaName = String(item.payload?.name ?? "");
        const schemaDef = schemaDefSchema.parse(item.payload?.schemaDef ?? null);
        ensureSchemaI18nFallback(schemaDef);
        const latest = await client(tx).query("SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1", [schemaName]);
        const nextVersionHint = (latest.rowCount ? Number(latest.rows[0].version) : 0) + 1;

        if (mode === "canary") {
          const migrationRunId = String(item.payload?.migrationRunId ?? "");
          for (const spaceId of targets) {
            const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
            if (compatReport.level === "breaking") throw new Error(`schema_breaking_change:${compatReport.digest.sha256_8}`);
            if (compatReport.level === "migration_required") {
              if (!migrationRunId) throw new Error(`schema_migration_required:${compatReport.digest.sha256_8}`);
              await assertMigrationGate({ pool: tx, tenantId: params.tenantId, migrationRunId, schemaName, targetVersion: nextVersionHint });
            }
          }
        } else {
          const spaceId = cs.scopeType === "space" ? cs.scopeId : undefined;
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
          const compatReport = computeSchemaCompatReportV1(prev?.schema ?? null, schemaDef);
          if (compatReport.level === "breaking") throw new Error(`schema_breaking_change:${compatReport.digest.sha256_8}`);
          if (compatReport.level === "migration_required") {
            const migrationRunId = String(item.payload?.migrationRunId ?? "");
            if (!migrationRunId) throw new Error(`schema_migration_required:${compatReport.digest.sha256_8}`);
            await assertMigrationGate({ pool: tx, tenantId: params.tenantId, migrationRunId, schemaName, targetVersion: nextVersionHint });
          }
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
        }

        const stored = await publishNewReleased(tx as any, schemaDef);
        rollback.schemaPublishedVersions[schemaName] = stored.version;

        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version: stored.version });
          }
        } else if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: stored.version });
        } else {
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: stored.version });
        }
        continue;
      }

      if (item.kind === "schema.set_active") {
        const schemaName = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const stored = await getByNameVersion(tx as any, schemaName, version);
        if (!stored || stored.status !== "released") throw new Error("invalid_item");
        const migrationRunId = String(item.payload?.migrationRunId ?? "");

        if (mode === "canary") {
          for (const spaceId of targets) {
            const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prev ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version });
          }
        } else if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version });
        }
        continue;
      }

      if (item.kind === "schema.rollback") {
        const schemaName = String(item.payload?.name ?? "");

        if (mode === "canary") {
          for (const spaceId of targets) {
            const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            if (!cur) throw new Error("schema_not_found");
            const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
            if (!prevVersion) throw new Error("schema_prev_missing");
            const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
            rollback.actions.push({ kind: "schema.set_active_override", spaceId, schemaName, version: prevOverride ?? null });
            await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version: prevVersion });
          }
        } else if (cs.scopeType === "space") {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prevOverride ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: prevVersion });
        } else {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: cur.version });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: prevVersion });
        }
        continue;
      }

      if (item.kind === "ui.page.publish") {
        const pageName = String(item.payload?.pageName ?? "");
        if (!pageName) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        const cur = await getLatestReleasedPage(tx as any, key);
        const draftRow = await getPageDraft(tx as any, key);
        if (!draftRow) throw new Error("contract_not_compatible");
        const draft = pageDraftSchema.parse({
          title: draftRow.title ?? undefined,
          pageType: draftRow.pageType,
          params: draftRow.params ?? undefined,
          dataBindings: draftRow.dataBindings ?? undefined,
          actionBindings: draftRow.actionBindings ?? undefined,
          ui: draftRow.ui ?? undefined,
        });
        for (const a of draft.actionBindings ?? []) {
          const ver = await getToolVersionByRef(tx as any, params.tenantId, a.toolRef);
          if (!ver || ver.status !== "released") throw new Error("contract_not_compatible");
          const rawToolRef = String(a.toolRef ?? "");
          const at = rawToolRef.lastIndexOf("@");
          const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
          const def = await getToolDefinition(tx as any, params.tenantId, toolName);
          if (!def) throw new Error("contract_not_compatible");
          const idempotencyRequired = Boolean(def.idempotencyRequired);
          const approvalRequired = Boolean(def.approvalRequired) || def.riskLevel === "high";
          if (idempotencyRequired && String((a as any).idempotencyKeyStrategy ?? "") !== "required") throw new Error("contract_not_compatible");
          if (approvalRequired && String((a as any).approval ?? "") !== "required") throw new Error("contract_not_compatible");
          if (approvalRequired) {
            const cm = (a as any).confirmMessage;
            const hasZh = cm && typeof cm === "object" && String((cm as any)["zh-CN"] ?? "").trim().length > 0;
            const hasEn = cm && typeof cm === "object" && String((cm as any)["en-US"] ?? "").trim().length > 0;
            if (!hasZh && !hasEn) throw new Error("contract_not_compatible");
          }
        }
        const published = await publishPageFromDraft(tx as any, key);
        if (!published) throw new Error("contract_not_compatible");
        rollback.actions.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, publishedVersion: published.version });
        continue;
      }

      if (item.kind === "ui.page.rollback") {
        const pageName = String(item.payload?.pageName ?? "");
        if (!pageName) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        const cur = await getLatestReleasedPage(tx as any, key);
        const rolled = await rollbackPageToPreviousReleased(tx as any, key);
        if (!rolled) throw new Error("ui_no_previous_version");
        rollback.actions.push({ kind: "ui.page.restore", pageName, restoreToVersion: cur?.version ?? null, publishedVersion: rolled.version });
        continue;
      }

      if (item.kind === "policy.cache.invalidate") {
        const scopeType = String(item.payload?.scopeType ?? "") as any;
        const scopeId = String(item.payload?.scopeId ?? "");
        const reason = String(item.payload?.reason ?? "");
        if (!scopeId || !reason) throw new Error("invalid_item");
        await bumpPolicyCacheEpoch({ pool: tx as any, tenantId: params.tenantId, scopeType: scopeType ?? cs.scopeType, scopeId: scopeId ?? cs.scopeId });
        continue;
      }

      if (item.kind === "policy.version.release") {
        const name = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!name || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const cc = await checkPolicyVersionContract({ pool: tx as any, tenantId: params.tenantId, name, version });
        if (cc.status === "fail") throw new Error("contract_not_compatible");
        const prevRes = await tx.query(
          `SELECT status, published_at FROM policy_versions WHERE tenant_id = $1 AND name = $2 AND version = $3 LIMIT 1`,
          [params.tenantId, name, version],
        );
        if (!prevRes.rowCount) throw new Error("contract_not_compatible");
        const prev = prevRes.rows[0];
        rollback.actions.push({ kind: "policy.version.restore", name, version, prevStatus: String(prev.status), prevPublishedAt: prev.published_at ?? null });
        const upd = await tx.query(
          `UPDATE policy_versions SET status = 'released', published_at = now() WHERE tenant_id = $1 AND name = $2 AND version = $3 AND status = 'draft' RETURNING id`,
          [params.tenantId, name, version],
        );
        if (!upd.rowCount) throw new Error("contract_not_compatible");
        await bumpPolicyCacheEpoch({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType as any, scopeId: cs.scopeId });
        continue;
      }

      if (item.kind === "policy.publish") {
        const policyId = String(item.payload?.policyId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(
          `
            SELECT v.status, v.published_at
            FROM safety_policy_versions v
            JOIN safety_policies p ON p.policy_id = v.policy_id
            WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
            LIMIT 1
          `,
          [params.tenantId, policyId, version],
        );
        if (!prevRes.rowCount) throw new Error("contract_not_compatible");
        rollback.actions.push({
          kind: "safety_policy.version.restore",
          policyId,
          version,
          prevStatus: String(prevRes.rows[0].status),
          prevPublishedAt: prevRes.rows[0].published_at ?? null,
        });
        const upd = await tx.query(
          `
            UPDATE safety_policy_versions v
            SET status = 'released', published_at = COALESCE(published_at, now()), updated_at = now()
            WHERE v.policy_id = $1 AND v.version = $2
              AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3)
              AND v.status IN ('draft','submitted','approved')
            RETURNING policy_id
          `,
          [policyId, version, params.tenantId],
        );
        if (!upd.rowCount) throw new Error("contract_not_compatible");
        continue;
      }

      if (item.kind === "policy.set_active") {
        const policyId = String(item.payload?.policyId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [
          params.tenantId,
          policyId,
        ]);
        rollback.actions.push({
          kind: "safety_policy.set_active",
          policyId,
          prevVersion: prevRes.rowCount ? Number(prevRes.rows[0].active_version) : null,
        });
        await tx.query(
          `
            INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version)
            VALUES ($1,$2,$3)
            ON CONFLICT (tenant_id, policy_id)
            DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
          `,
          [params.tenantId, policyId, version],
        );
        continue;
      }

      if (item.kind === "policy.rollback") {
        const policyId = String(item.payload?.policyId ?? "");
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("invalid_item");
        const curRes = await tx.query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [params.tenantId, policyId]);
        if (!curRes.rowCount) throw new Error("invalid_item");
        const cur = Number(curRes.rows[0].active_version);
        const prevRes = await tx.query(
          `SELECT version FROM safety_policy_versions WHERE policy_id = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1`,
          [policyId, cur],
        );
        if (!prevRes.rowCount) throw new Error("policy_no_previous_version");
        const prev = Number(prevRes.rows[0].version);
        rollback.actions.push({ kind: "safety_policy.set_active", policyId, prevVersion: cur });
        await tx.query(
          `
            INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version)
            VALUES ($1,$2,$3)
            ON CONFLICT (tenant_id, policy_id)
            DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
          `,
          [params.tenantId, policyId, prev],
        );
        continue;
      }

      if (item.kind === "policy.set_override") {
        const policyId = String(item.payload?.policyId ?? "");
        const spaceId = String(item.payload?.spaceId ?? "");
        const version = Number(item.payload?.version);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !spaceId || !Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const prevRes = await tx.query(
          `SELECT active_version FROM safety_policy_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND policy_id = $3 LIMIT 1`,
          [params.tenantId, spaceId, policyId],
        );
        rollback.actions.push({
          kind: "safety_policy.set_override",
          policyId,
          spaceId,
          prevVersion: prevRes.rowCount ? Number(prevRes.rows[0].active_version) : null,
        });
        await tx.query(
          `
            INSERT INTO safety_policy_active_overrides (tenant_id, space_id, policy_id, active_version)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (tenant_id, space_id, policy_id)
            DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
          `,
          [params.tenantId, spaceId, policyId, version],
        );
        continue;
      }

      if (item.kind === "workbench.plugin.publish") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        if (!workbenchKey) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const prevActive = await getWorkbenchActiveVersion({ pool: tx as any, ...key });
        const published = await publishWorkbenchFromDraft({ pool: tx as any, ...key, createdBySubjectId: params.releasedBy });
        if (!published) throw new Error("contract_not_compatible");
        rollback.actions.push({ kind: "workbench.set_active", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, version: prevActive ?? null });
        continue;
      }

      if (item.kind === "workbench.plugin.rollback") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        if (!workbenchKey) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const prev = await getWorkbenchActiveVersion({ pool: tx as any, ...key });
        rollback.actions.push({ kind: "workbench.set_active", scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey, version: prev ?? null });
        await rollbackWorkbenchActiveToPreviousReleased({ pool: tx as any, ...key });
        continue;
      }

      if (item.kind === "workbench.plugin.canary") {
        const workbenchKey = String(item.payload?.workbenchKey ?? "");
        const canaryVersion = Number(item.payload?.canaryVersion);
        const subjectIds = Array.isArray(item.payload?.subjectIds) ? item.payload.subjectIds : [];
        if (!workbenchKey) throw new Error("invalid_item");
        if (!Number.isFinite(canaryVersion) || canaryVersion <= 0) throw new Error("invalid_item");
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, workbenchKey } as const;
        const prev = await getWorkbenchCanaryConfig({ pool: tx as any, ...key });
        rollback.actions.push({
          kind: "workbench.set_canary",
          scopeType: cs.scopeType,
          scopeId: cs.scopeId,
          workbenchKey,
          prev: prev ? { canaryVersion: prev.canaryVersion, subjectIds: prev.canarySubjectIds } : null,
        });
        if (subjectIds.length === 0) {
          await clearWorkbenchCanaryConfig({ pool: tx as any, ...key });
        } else {
          await setWorkbenchCanaryConfig({ pool: tx as any, ...key, canaryVersion, subjectIds });
        }
        continue;
      }

      if (item.kind === "model_routing.upsert") {
        const purpose = String(item.payload.purpose);
        const primaryModelRef = String(item.payload.primaryModelRef);
        const fallbackModelRefs = Array.isArray(item.payload.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
        const enabled = item.payload.enabled === undefined ? true : Boolean(item.payload.enabled);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prevRes = await tx.query(
              `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`,
              [params.tenantId, spaceId, purpose],
            );
            const prev = prevRes.rowCount
              ? {
                  primaryModelRef: prevRes.rows[0].primary_model_ref,
                  fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
                  enabled: Boolean(prevRes.rows[0].enabled),
                }
              : null;
            rollback.actions.push({ kind: "model_routing.override_restore", spaceId, purpose, prev });
            await tx.query(
              `
                INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled)
                VALUES ($1,$2,$3,$4,$5::jsonb,$6)
                ON CONFLICT (tenant_id, space_id, purpose)
                DO UPDATE SET
                  primary_model_ref = EXCLUDED.primary_model_ref,
                  fallback_model_refs = EXCLUDED.fallback_model_refs,
                  enabled = EXCLUDED.enabled,
                  updated_at = now()
              `,
              [params.tenantId, spaceId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled],
            );
          }
        } else {
          const prevRes = await tx.query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
            [params.tenantId, purpose],
          );
          const prev = prevRes.rowCount
            ? {
                primaryModelRef: prevRes.rows[0].primary_model_ref,
                fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
                enabled: Boolean(prevRes.rows[0].enabled),
              }
            : null;
          rollback.actions.push({ kind: "model_routing.restore", purpose, prev });

          await tx.query(
            `
              INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
              VALUES ($1,$2,$3,$4::jsonb,$5)
              ON CONFLICT (tenant_id, purpose)
              DO UPDATE SET
                primary_model_ref = EXCLUDED.primary_model_ref,
                fallback_model_refs = EXCLUDED.fallback_model_refs,
                enabled = EXCLUDED.enabled,
                updated_at = now()
            `,
            [params.tenantId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled],
          );
        }
        continue;
      }

      if (item.kind === "model_routing.disable") {
        const purpose = String(item.payload.purpose);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prevRes = await tx.query(
              `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3 LIMIT 1`,
              [params.tenantId, spaceId, purpose],
            );
            const prev = prevRes.rowCount
              ? {
                  primaryModelRef: prevRes.rows[0].primary_model_ref,
                  fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
                  enabled: Boolean(prevRes.rows[0].enabled),
                }
              : null;
            rollback.actions.push({ kind: "model_routing.override_restore", spaceId, purpose, prev });
            if (prevRes.rowCount) {
              await tx.query(
                `
                  UPDATE routing_policies_overrides
                  SET enabled = false, updated_at = now()
                  WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3
                `,
                [params.tenantId, spaceId, purpose],
              );
            } else {
              const baseRes = await tx.query(
                `SELECT primary_model_ref, fallback_model_refs FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
                [params.tenantId, purpose],
              );
              if (baseRes.rowCount) {
                await tx.query(
                  `
                    INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled)
                    VALUES ($1,$2,$3,$4,$5::jsonb,false)
                    ON CONFLICT (tenant_id, space_id, purpose)
                    DO UPDATE SET enabled = false, updated_at = now()
                  `,
                  [
                    params.tenantId,
                    spaceId,
                    purpose,
                    String(baseRes.rows[0].primary_model_ref),
                    JSON.stringify(Array.isArray(baseRes.rows[0].fallback_model_refs) ? baseRes.rows[0].fallback_model_refs : []),
                  ],
                );
              }
            }
          }
        } else {
          const prevRes = await tx.query(
            `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
            [params.tenantId, purpose],
          );
          const prev = prevRes.rowCount
            ? {
                primaryModelRef: prevRes.rows[0].primary_model_ref,
                fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
                enabled: Boolean(prevRes.rows[0].enabled),
              }
            : null;
          rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
          await tx.query(
            `
              UPDATE routing_policies
              SET enabled = false, updated_at = now()
              WHERE tenant_id = $1 AND purpose = $2
            `,
            [params.tenantId, purpose],
          );
        }
        continue;
      }

      if (item.kind === "model_limits.set") {
        /* rate limiting removed — skip */
        continue;
      }

      if (item.kind === "tool_limits.set") {
        const toolRef = String(item.payload.toolRef);
        const defaultMaxConcurrency = Number(item.payload.defaultMaxConcurrency);
        if (mode === "canary") {
          for (const spaceId of targets) {
            const prevRes = await tx.query(
              `SELECT default_max_concurrency FROM tool_limits_overrides WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3 LIMIT 1`,
              [params.tenantId, spaceId, toolRef],
            );
            const prevC = prevRes.rowCount ? Number(prevRes.rows[0].default_max_concurrency) : null;
            rollback.actions.push({ kind: "tool_limits.override_restore", spaceId, toolRef, prevDefaultMaxConcurrency: prevC });
            await tx.query(
              `
                INSERT INTO tool_limits_overrides (tenant_id, space_id, tool_ref, default_max_concurrency)
                VALUES ($1,$2,$3,$4)
                ON CONFLICT (tenant_id, space_id, tool_ref)
                DO UPDATE SET
                  default_max_concurrency = EXCLUDED.default_max_concurrency,
                  updated_at = now()
              `,
              [params.tenantId, spaceId, toolRef, defaultMaxConcurrency],
            );
          }
        } else {
          const prevRes = await tx.query(
            `SELECT default_max_concurrency FROM tool_limits WHERE tenant_id = $1 AND tool_ref = $2 LIMIT 1`,
            [params.tenantId, toolRef],
          );
          const prevC = prevRes.rowCount ? Number(prevRes.rows[0].default_max_concurrency) : null;
          rollback.actions.push({ kind: "tool_limits.restore", toolRef, prevDefaultMaxConcurrency: prevC });
          await tx.query(
            `
              INSERT INTO tool_limits (tenant_id, tool_ref, default_max_concurrency)
              VALUES ($1,$2,$3)
              ON CONFLICT (tenant_id, tool_ref)
              DO UPDATE SET
                default_max_concurrency = EXCLUDED.default_max_concurrency,
                updated_at = now()
            `,
            [params.tenantId, toolRef, defaultMaxConcurrency],
          );
        }
        continue;
      }

      if (item.kind === "artifact_policy.upsert") {
        const scopeType = String(item.payload.scopeType) as "tenant" | "space";
        const scopeId = String(item.payload.scopeId);
        const downloadTokenExpiresInSec = Number(item.payload.downloadTokenExpiresInSec);
        const downloadTokenMaxUses = Number(item.payload.downloadTokenMaxUses);
        const watermarkHeadersEnabled = Boolean(item.payload.watermarkHeadersEnabled);

        const prevRes = await tx.query(
          `SELECT download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 LIMIT 1`,
          [params.tenantId, scopeType, scopeId],
        );
        const prev = prevRes.rowCount
          ? {
              scopeType,
              scopeId,
              downloadTokenExpiresInSec: Number(prevRes.rows[0].download_token_expires_in_sec),
              downloadTokenMaxUses: Number(prevRes.rows[0].download_token_max_uses),
              watermarkHeadersEnabled: Boolean(prevRes.rows[0].watermark_headers_enabled),
            }
          : null;
        rollback.actions.push({ kind: "artifact_policy.restore", scopeType, scopeId, prev });

        await tx.query(
          `
            INSERT INTO artifact_policies (
              tenant_id, scope_type, scope_id,
              download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled
            )
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
            SET download_token_expires_in_sec = EXCLUDED.download_token_expires_in_sec,
                download_token_max_uses = EXCLUDED.download_token_max_uses,
                watermark_headers_enabled = EXCLUDED.watermark_headers_enabled,
                updated_at = now()
          `,
          [params.tenantId, scopeType, scopeId, downloadTokenExpiresInSec, downloadTokenMaxUses, watermarkHeadersEnabled],
        );
        continue;
      }
    }

    const upd = await tx.query(
      `
        UPDATE governance_changesets
        SET status = 'released',
            released_by = $3,
            released_at = now(),
            rollback_data = $4,
            canary_released_at = CASE WHEN $5 = 'canary' THEN now() ELSE NULL END,
            updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `,
      [params.tenantId, params.id, params.releasedBy, rollback, mode],
    );
    await tx.query("COMMIT");
    return toCs(upd.rows[0]);
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export async function promoteChangeSet(params: { pool: Pool; tenantId: string; id: string; promotedBy: string }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "released") throw new Error("changeset_not_released");
  if (!cs.canaryReleasedAt) throw new Error("changeset_not_canary_released");
  if (cs.promotedAt) throw new Error("changeset_already_promoted");
  const targets = cs.canaryTargets ?? [];
  if (!targets.length) throw new Error("canary_targets_missing");

  const items = await listChangeSetItems({ pool: params.pool, tenantId: params.tenantId, changesetId: params.id });
  const rollback = cs.rollbackData && Array.isArray(cs.rollbackData.actions) ? cs.rollbackData : { actions: [] };

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT status, promoted_at FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount || locked.rows[0].status !== "released") throw new Error("changeset_not_released");
    if (locked.rows[0].promoted_at) throw new Error("changeset_already_promoted");

    for (const item of items) {
      await validateItem(tx, params.tenantId, item);

      if (item.kind === "tool.enable" || item.kind === "tool.disable") {
        const toolRef = String(item.payload.toolRef);
        const enabled = item.kind === "tool.enable";
        const prev = await getToolRolloutEnabled({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef });
        rollback.actions.push({ kind: "tool.set_enabled", scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled: prev });
        await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, toolRef, enabled });

        for (const spaceId of targets) {
          await deleteToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType: "space", scopeId: spaceId, toolRef });
        }
        continue;
      }

      if (item.kind === "tool.set_active") {
        const toolRef = String(item.payload.toolRef);
        const name = String(item.payload.name);
        const prev = await getActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
        rollback.actions.push({ kind: "tool.set_active", name, toolRef: prev?.activeToolRef ?? null });
        await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });

        for (const spaceId of targets) {
          await clearActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
        }
        continue;
      }

      if (item.kind === "schema.publish") {
        const schemaName = String(item.payload?.name ?? "");
        const published = Number(rollback.schemaPublishedVersions?.[schemaName]);
        const latest = await tx.query(
          "SELECT version FROM schemas WHERE name = $1 AND status = 'released' ORDER BY version DESC LIMIT 1",
          [schemaName],
        );
        const version = Number.isFinite(published) && published > 0 ? published : latest.rowCount ? Number(latest.rows[0].version) : null;
        if (!version) throw new Error("schema_published_missing");

        if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: version as any });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: version as any });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "schema.set_active") {
        const schemaName = String(item.payload?.name ?? "");
        const version = Number(item.payload?.version);
        if (!Number.isFinite(version) || version <= 0) throw new Error("invalid_item");
        const stored = await getByNameVersion(tx as any, schemaName, version);
        if (!stored || stored.status !== "released") throw new Error("invalid_item");

        if (cs.scopeType === "space") {
          const prev = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prev ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version });
        } else {
          const prev = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: prev?.version ?? null });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "schema.rollback") {
        const schemaName = String(item.payload?.name ?? "");
        if (cs.scopeType === "space") {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          const prevOverride = await getActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName });
          rollback.actions.push({ kind: "schema.set_active_override", spaceId: cs.scopeId, schemaName, version: prevOverride ?? null });
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId: cs.scopeId, name: schemaName, version: prevVersion });
        } else {
          const cur = await getEffectiveSchema({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
          if (!cur) throw new Error("schema_not_found");
          const prevVersion = await getPreviousReleasedSchemaVersion({ pool: tx as any, name: schemaName, beforeVersion: cur.version });
          if (!prevVersion) throw new Error("schema_prev_missing");
          rollback.actions.push({ kind: "schema.set_active", schemaName, version: cur.version });
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version: prevVersion });
        }
        for (const spaceId of targets) await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        continue;
      }

      if (item.kind === "model_routing.upsert") {
        const purpose = String(item.payload.purpose);
        const primaryModelRef = String(item.payload.primaryModelRef);
        const fallbackModelRefs = Array.isArray(item.payload.fallbackModelRefs) ? item.payload.fallbackModelRefs : [];
        const enabled = item.payload.enabled === undefined ? true : Boolean(item.payload.enabled);

        const prevRes = await tx.query(
          `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
          [params.tenantId, purpose],
        );
        const prev = prevRes.rowCount
          ? {
              primaryModelRef: prevRes.rows[0].primary_model_ref,
              fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
              enabled: Boolean(prevRes.rows[0].enabled),
            }
          : null;
        rollback.actions.push({ kind: "model_routing.restore", purpose, prev });

        await tx.query(
          `
            INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
            VALUES ($1,$2,$3,$4::jsonb,$5)
            ON CONFLICT (tenant_id, purpose)
            DO UPDATE SET
              primary_model_ref = EXCLUDED.primary_model_ref,
              fallback_model_refs = EXCLUDED.fallback_model_refs,
              enabled = EXCLUDED.enabled,
              updated_at = now()
          `,
          [params.tenantId, purpose, primaryModelRef, JSON.stringify(fallbackModelRefs), enabled],
        );

        for (const spaceId of targets) {
          await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
        }
        continue;
      }

      if (item.kind === "model_routing.disable") {
        const purpose = String(item.payload.purpose);
        const prevRes = await tx.query(
          `SELECT primary_model_ref, fallback_model_refs, enabled FROM routing_policies WHERE tenant_id = $1 AND purpose = $2 LIMIT 1`,
          [params.tenantId, purpose],
        );
        const prev = prevRes.rowCount
          ? {
              primaryModelRef: prevRes.rows[0].primary_model_ref,
              fallbackModelRefs: Array.isArray(prevRes.rows[0].fallback_model_refs) ? prevRes.rows[0].fallback_model_refs : [],
              enabled: Boolean(prevRes.rows[0].enabled),
            }
          : null;
        rollback.actions.push({ kind: "model_routing.restore", purpose, prev });
        await tx.query(`UPDATE routing_policies SET enabled = false, updated_at = now() WHERE tenant_id = $1 AND purpose = $2`, [params.tenantId, purpose]);

        for (const spaceId of targets) {
          await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
        }
        continue;
      }

      if (item.kind === "tool_limits.set") {
        const toolRef = String(item.payload.toolRef);
        const defaultMaxConcurrency = Number(item.payload.defaultMaxConcurrency);
        const prevRes = await tx.query(
          `SELECT default_max_concurrency FROM tool_limits WHERE tenant_id = $1 AND tool_ref = $2 LIMIT 1`,
          [params.tenantId, toolRef],
        );
        const prevC = prevRes.rowCount ? Number(prevRes.rows[0].default_max_concurrency) : null;
        rollback.actions.push({ kind: "tool_limits.restore", toolRef, prevDefaultMaxConcurrency: prevC });
        await tx.query(
          `
            INSERT INTO tool_limits (tenant_id, tool_ref, default_max_concurrency)
            VALUES ($1,$2,$3)
            ON CONFLICT (tenant_id, tool_ref)
            DO UPDATE SET default_max_concurrency = EXCLUDED.default_max_concurrency, updated_at = now()
          `,
          [params.tenantId, toolRef, defaultMaxConcurrency],
        );
        for (const spaceId of targets) {
          await tx.query(`DELETE FROM tool_limits_overrides WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3`, [params.tenantId, spaceId, toolRef]);
        }
        continue;
      }

      if (item.kind === "model_limits.set") {
        /* rate limiting removed — skip */
        continue;
      }
    }

    const upd = await tx.query(
      `
        UPDATE governance_changesets
        SET promoted_at = now(), rollback_data = $3, updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *
      `,
      [params.tenantId, params.id, rollback],
    );
    await tx.query("COMMIT");
    return toCs(upd.rows[0]);
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

export async function rollbackChangeSet(params: { pool: Pool; tenantId: string; id: string; createdBy: string }) {
  const cs = await getChangeSet(params);
  if (!cs) throw new Error("changeset_not_found");
  if (cs.status !== "released") throw new Error("changeset_not_released");
  const rollback = cs.rollbackData;
  if (!rollback || !Array.isArray(rollback.actions)) throw new Error("rollback_data_missing");

  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const locked = await tx.query(
      `SELECT status, scope_type, scope_id FROM governance_changesets WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [params.tenantId, params.id],
    );
    if (!locked.rowCount || locked.rows[0].status !== "released") throw new Error("changeset_not_released");

    const rb = await createChangeSet({ pool: tx as any, tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, title: `rollback:${cs.id}`, createdBy: params.createdBy });
    await tx.query(
      `UPDATE governance_changesets SET rollback_of = $3, status = 'approved', approved_by = $4, approved_at = now(), updated_at = now() WHERE id = $2 AND tenant_id = $1`,
      [params.tenantId, rb.id, cs.id, params.createdBy],
    );

    for (const a of rollback.actions) {
      if (a.kind === "tool.set_enabled") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        if (a.enabled === null || a.enabled === undefined) {
          await deleteToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, toolRef: String(a.toolRef) });
        } else {
          await setToolRollout({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, toolRef: String(a.toolRef), enabled: Boolean(a.enabled) });
        }
        continue;
      }
      if (a.kind === "tool.set_active") {
        const name = String(a.name);
        const toolRef = a.toolRef ? String(a.toolRef) : null;
        if (toolRef) await setActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name, toolRef });
        else await clearActiveToolRef({ pool: tx as any, tenantId: params.tenantId, name });
        continue;
      }
      if (a.kind === "tool.set_active_override") {
        const spaceId = String(a.spaceId);
        const name = String(a.name);
        const toolRef = a.toolRef ? String(a.toolRef) : null;
        if (toolRef) await setActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name, toolRef });
        else await clearActiveToolOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name });
        continue;
      }
      if (a.kind === "model_routing.restore") {
        const purpose = String(a.purpose);
        const prev = a.prev ?? null;
        if (!prev) {
          await tx.query(`DELETE FROM routing_policies WHERE tenant_id = $1 AND purpose = $2`, [params.tenantId, purpose]);
        } else {
          await tx.query(
            `
              INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
              VALUES ($1,$2,$3,$4::jsonb,$5)
              ON CONFLICT (tenant_id, purpose)
              DO UPDATE SET
                primary_model_ref = EXCLUDED.primary_model_ref,
                fallback_model_refs = EXCLUDED.fallback_model_refs,
                enabled = EXCLUDED.enabled,
                updated_at = now()
            `,
            [params.tenantId, purpose, String(prev.primaryModelRef), JSON.stringify(Array.isArray(prev.fallbackModelRefs) ? prev.fallbackModelRefs : []), Boolean(prev.enabled)],
          );
        }
        continue;
      }
      if (a.kind === "model_routing.override_restore") {
        const spaceId = String(a.spaceId);
        const purpose = String(a.purpose);
        const prev = a.prev ?? null;
        if (!prev) {
          await tx.query(`DELETE FROM routing_policies_overrides WHERE tenant_id = $1 AND space_id = $2 AND purpose = $3`, [params.tenantId, spaceId, purpose]);
        } else {
          await tx.query(
            `
              INSERT INTO routing_policies_overrides (tenant_id, space_id, purpose, primary_model_ref, fallback_model_refs, enabled)
              VALUES ($1,$2,$3,$4,$5::jsonb,$6)
              ON CONFLICT (tenant_id, space_id, purpose)
              DO UPDATE SET
                primary_model_ref = EXCLUDED.primary_model_ref,
                fallback_model_refs = EXCLUDED.fallback_model_refs,
                enabled = EXCLUDED.enabled,
                updated_at = now()
            `,
            [params.tenantId, spaceId, purpose, String(prev.primaryModelRef), JSON.stringify(Array.isArray(prev.fallbackModelRefs) ? prev.fallbackModelRefs : []), Boolean(prev.enabled)],
          );
        }
        continue;
      }
      if (a.kind === "model_limits.restore") {
        /* rate limiting removed — skip */
        continue;
      }
      if (a.kind === "tool_limits.restore") {
        const toolRef = String(a.toolRef);
        const prevC = a.prevDefaultMaxConcurrency === null || a.prevDefaultMaxConcurrency === undefined ? null : Number(a.prevDefaultMaxConcurrency);
        if (prevC === null) {
          await tx.query(`DELETE FROM tool_limits WHERE tenant_id = $1 AND tool_ref = $2`, [params.tenantId, toolRef]);
        } else {
          await tx.query(
            `
              INSERT INTO tool_limits (tenant_id, tool_ref, default_max_concurrency)
              VALUES ($1,$2,$3)
              ON CONFLICT (tenant_id, tool_ref)
              DO UPDATE SET default_max_concurrency = EXCLUDED.default_max_concurrency, updated_at = now()
            `,
            [params.tenantId, toolRef, prevC],
          );
        }
        continue;
      }
      if (a.kind === "tool_limits.override_restore") {
        const spaceId = String(a.spaceId);
        const toolRef = String(a.toolRef);
        const prevC = a.prevDefaultMaxConcurrency === null || a.prevDefaultMaxConcurrency === undefined ? null : Number(a.prevDefaultMaxConcurrency);
        if (prevC === null) {
          await tx.query(`DELETE FROM tool_limits_overrides WHERE tenant_id = $1 AND space_id = $2 AND tool_ref = $3`, [params.tenantId, spaceId, toolRef]);
        } else {
          await tx.query(
            `
              INSERT INTO tool_limits_overrides (tenant_id, space_id, tool_ref, default_max_concurrency)
              VALUES ($1,$2,$3,$4)
              ON CONFLICT (tenant_id, space_id, tool_ref)
              DO UPDATE SET default_max_concurrency = EXCLUDED.default_max_concurrency, updated_at = now()
            `,
            [params.tenantId, spaceId, toolRef, prevC],
          );
        }
        continue;
      }
      if (a.kind === "artifact_policy.restore") {
        const scopeType = String(a.scopeType);
        const scopeId = String(a.scopeId);
        const prev = a.prev ?? null;
        if (!prev) {
          await tx.query(`DELETE FROM artifact_policies WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3`, [params.tenantId, scopeType, scopeId]);
        } else {
          await tx.query(
            `
              INSERT INTO artifact_policies (
                tenant_id, scope_type, scope_id,
                download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled
              )
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
              SET download_token_expires_in_sec = EXCLUDED.download_token_expires_in_sec,
                  download_token_max_uses = EXCLUDED.download_token_max_uses,
                  watermark_headers_enabled = EXCLUDED.watermark_headers_enabled,
                  updated_at = now()
            `,
            [
              params.tenantId,
              scopeType,
              scopeId,
              Number(prev.downloadTokenExpiresInSec),
              Number(prev.downloadTokenMaxUses),
              Boolean(prev.watermarkHeadersEnabled),
            ],
          );
        }
        continue;
      }
      if (a.kind === "policy.version.restore") {
        const name = String(a.name ?? "");
        const version = Number(a.version);
        const prevStatus = String(a.prevStatus ?? "draft");
        const prevPublishedAt = a.prevPublishedAt ?? null;
        if (!name || !Number.isFinite(version) || version <= 0) throw new Error("rollback_failed");
        await tx.query(
          `UPDATE policy_versions SET status = $4, published_at = $5 WHERE tenant_id = $1 AND name = $2 AND version = $3`,
          [params.tenantId, name, version, prevStatus, prevPublishedAt],
        );
        continue;
      }
      if (a.kind === "safety_policy.version.restore") {
        const policyId = String(a.policyId ?? "");
        const version = Number(a.version);
        const prevStatus = String(a.prevStatus ?? "draft");
        const prevPublishedAt = a.prevPublishedAt ?? null;
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !Number.isFinite(version) || version <= 0) throw new Error("rollback_failed");
        await tx.query(
          `
            UPDATE safety_policy_versions v
            SET status = $4, published_at = $5, updated_at = now()
            WHERE v.policy_id = $1 AND v.version = $2
              AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3)
          `,
          [policyId, version, params.tenantId, prevStatus, prevPublishedAt],
        );
        continue;
      }
      if (a.kind === "safety_policy.set_active") {
        const policyId = String(a.policyId ?? "");
        const prevVersion = a.prevVersion === null || a.prevVersion === undefined ? null : Number(a.prevVersion);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId)) throw new Error("rollback_failed");
        if (prevVersion === null) {
          await tx.query(`DELETE FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2`, [params.tenantId, policyId]);
        } else {
          await tx.query(
            `
              INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version)
              VALUES ($1,$2,$3)
              ON CONFLICT (tenant_id, policy_id)
              DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
            `,
            [params.tenantId, policyId, prevVersion],
          );
        }
        continue;
      }
      if (a.kind === "safety_policy.set_override") {
        const policyId = String(a.policyId ?? "");
        const spaceId = String(a.spaceId ?? "");
        const prevVersion = a.prevVersion === null || a.prevVersion === undefined ? null : Number(a.prevVersion);
        if (!/^[0-9a-fA-F-]{36}$/.test(policyId) || !spaceId) throw new Error("rollback_failed");
        if (prevVersion === null) {
          await tx.query(`DELETE FROM safety_policy_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND policy_id = $3`, [params.tenantId, spaceId, policyId]);
        } else {
          await tx.query(
            `
              INSERT INTO safety_policy_active_overrides (tenant_id, space_id, policy_id, active_version)
              VALUES ($1,$2,$3,$4)
              ON CONFLICT (tenant_id, space_id, policy_id)
              DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
            `,
            [params.tenantId, spaceId, policyId, prevVersion],
          );
        }
        continue;
      }
      if (a.kind === "schema.set_active") {
        const schemaName = String(a.schemaName);
        const version = a.version === null || a.version === undefined ? null : Number(a.version);
        if (version === null) {
          await clearActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName });
        } else {
          await setActiveSchemaVersion({ pool: tx as any, tenantId: params.tenantId, name: schemaName, version });
        }
        continue;
      }
      if (a.kind === "schema.set_active_override") {
        const spaceId = String(a.spaceId);
        const schemaName = String(a.schemaName);
        const version = a.version === null || a.version === undefined ? null : Number(a.version);
        if (version === null) {
          await clearActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName });
        } else {
          await setActiveSchemaOverride({ pool: tx as any, tenantId: params.tenantId, spaceId, name: schemaName, version });
        }
        continue;
      }
      if (a.kind === "ui.page.restore") {
        const pageName = String(a.pageName);
        const publishedVersion = Number(a.publishedVersion);
        const restoreToVersion = a.restoreToVersion === null || a.restoreToVersion === undefined ? null : Number(a.restoreToVersion);
        const key = { tenantId: params.tenantId, scopeType: cs.scopeType, scopeId: cs.scopeId, name: pageName } as const;
        if (restoreToVersion === null) {
          await setPageVersionStatus(tx as any, key, publishedVersion, "rolled_back");
        } else {
          const cloned = await cloneReleasedVersion(tx as any, key, restoreToVersion);
          if (!cloned) throw new Error("ui_restore_missing_source");
        }
        continue;
      }
      if (a.kind === "workbench.set_active") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        const workbenchKey = String(a.workbenchKey);
        const version = a.version === null || a.version === undefined ? null : Number(a.version);
        if (version === null) {
          await clearWorkbenchActiveVersion({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey });
        } else {
          await setWorkbenchActiveVersion({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey, activeVersion: version });
        }
        continue;
      }
      if (a.kind === "workbench.set_canary") {
        const scopeType = (a.scopeType as "tenant" | "space" | undefined) ?? cs.scopeType;
        const scopeId = (a.scopeId as string | undefined) ?? cs.scopeId;
        const workbenchKey = String(a.workbenchKey);
        const prev = a.prev ?? null;
        if (!prev) {
          await clearWorkbenchCanaryConfig({ pool: tx as any, tenantId: params.tenantId, scopeType, scopeId, workbenchKey });
        } else {
          await setWorkbenchCanaryConfig({
            pool: tx as any,
            tenantId: params.tenantId,
            scopeType,
            scopeId,
            workbenchKey,
            canaryVersion: Number(prev.canaryVersion),
            subjectIds: Array.isArray(prev.subjectIds) ? prev.subjectIds : [],
          });
        }
        continue;
      }
    }

    await tx.query(
      `UPDATE governance_changesets SET status = 'rolled_back', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, cs.id],
    );
    await tx.query(
      `UPDATE governance_changesets SET status = 'released', released_by = $3, released_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, rb.id, params.createdBy],
    );

    await tx.query("COMMIT");
    const out = await getChangeSet({ pool: params.pool, tenantId: params.tenantId, id: rb.id });
    if (!out) throw new Error("rollback_created_missing");
    return out;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

/**
 * Item-kind prefixes that mandate eval-admission gate.
 * Configurable via EVAL_ADMISSION_REQUIRED_KINDS (comma-separated prefixes).
 * Default: tool.set_active, tool.enable, policy., model_routing., schema.
 */
const EVAL_ADMISSION_REQUIRED_KINDS: string[] = (() => {
  const raw = process.env.EVAL_ADMISSION_REQUIRED_KINDS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ["tool.set_active", "tool.enable", "policy.", "model_routing.", "schema."];
})();

function itemMatchesEvalKinds(kind: string): boolean {
  return EVAL_ADMISSION_REQUIRED_KINDS.some((prefix) => kind === prefix || kind.startsWith(prefix));
}

async function computeApprovalGate(params: { pool: Pool; tenantId: string; items: ChangeSetItemRow[] }) {
  let risk: "low" | "medium" | "high" = "low";
  let requireTwo = false;
  let evalAdmissionRequired = false;

  for (const item of params.items) {
    if (itemMatchesEvalKinds(item.kind)) {
      evalAdmissionRequired = true;
    }
    if (item.kind.startsWith("ui.")) {
      risk = "high";
      requireTwo = true;
      continue;
    }
    if (item.kind.startsWith("schema.")) {
      risk = "high";
      requireTwo = true;
      continue;
    }
    if (item.kind.startsWith("workbench.")) {
      risk = "high";
      requireTwo = true;
      continue;
    }
    if (item.kind.startsWith("policy.")) {
      risk = "high";
      requireTwo = true;
      continue;
    }
    if (item.kind.startsWith("model_routing.")) {
      risk = "high";
      requireTwo = true;
      continue;
    }
    if (!item.kind.startsWith("tool.")) continue;
    const toolRef = item.kind === "tool.set_active" ? String(item.payload?.toolRef ?? "") : String(item.payload?.toolRef ?? "");
    const name = item.kind === "tool.set_active" ? String(item.payload?.name ?? "") : toolRef.slice(0, Math.max(0, toolRef.lastIndexOf("@")));
    if (!name) continue;
    const def = await getToolDefinition(params.pool, params.tenantId, name);
    const r = def?.riskLevel ?? "low";
    if (r === "high") risk = "high";
    else if (risk !== "high" && r === "medium") risk = "medium";
    if (def?.approvalRequired) requireTwo = true;
  }

  const requiredApprovals = risk === "high" || requireTwo ? 2 : 1;
  return { riskLevel: risk, requiredApprovals, evalAdmissionRequired };
}
