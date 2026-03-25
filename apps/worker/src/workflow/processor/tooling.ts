import type { Pool } from "pg";
import { isPlainObject } from "./common";

export function buildSafeToolOutput(toolName: string, output: any) {
  if (!isPlainObject(output)) return null;
  if (toolName === "entity.create" || toolName === "entity.update") {
    const out: any = {};
    if (typeof output.recordId === "string") out.recordId = output.recordId;
    if (typeof output.idempotentHit === "boolean") out.idempotentHit = output.idempotentHit;
    return out;
  }
  if (toolName === "entity.delete") {
    const out: any = {};
    if (typeof output.recordId === "string") out.recordId = output.recordId;
    if (typeof output.idempotentHit === "boolean") out.idempotentHit = output.idempotentHit;
    if (typeof output.deleted === "boolean") out.deleted = output.deleted;
    return out;
  }
  if (toolName === "memory.write") {
    const out: any = {};
    if (isPlainObject(output.entry)) out.entry = output.entry;
    if (isPlainObject(output.dlpSummary)) out.dlpSummary = output.dlpSummary;
    return out;
  }
  if (toolName === "memory.read") {
    const out: any = {};
    if (typeof output.candidateCount === "number") out.candidateCount = output.candidateCount;
    if (Array.isArray(output.evidence)) out.evidenceCount = output.evidence.length;
    return out;
  }
  if (toolName === "knowledge.search") {
    const out: any = {};
    if (typeof output.retrievalLogId === "string") out.retrievalLogId = output.retrievalLogId;
    if (typeof output.candidateCount === "number") out.candidateCount = output.candidateCount;
    if (Array.isArray(output.evidence)) out.evidenceCount = output.evidence.length;
    return out;
  }
  if (toolName === "collab.guard") {
    const out: any = {};
    if (typeof output.allow === "boolean") out.allow = output.allow;
    if (typeof output.requiresApproval === "boolean") out.requiresApproval = output.requiresApproval;
    if (Array.isArray(output.blockedReasons)) out.blockedReasonCount = output.blockedReasons.length;
    if (typeof output.recommendedArbiterAction === "string") out.recommendedArbiterAction = output.recommendedArbiterAction;
    return out;
  }
  if (toolName === "collab.review") {
    const out: any = {};
    if (typeof output.finalAnswer === "string") out.finalAnswerLen = output.finalAnswer.length;
    if (typeof output.citationsCount === "number") out.citationsCount = output.citationsCount;
    return out;
  }
  if (toolName === "sleep") {
    const out: any = {};
    if (typeof output.sleptMs === "number") out.sleptMs = output.sleptMs;
    return out;
  }
  if (toolName === "http.get") {
    const out: any = {};
    if (typeof output.status === "number") out.status = output.status;
    if (typeof output.textLen === "number") out.textLen = output.textLen;
    return out;
  }
  return null;
}

export function parseToolRef(toolRef: string) {
  const idx = toolRef.lastIndexOf("@");
  if (idx <= 0 || idx >= toolRef.length - 1) return null;
  const name = toolRef.slice(0, idx);
  const version = Number(toolRef.slice(idx + 1));
  if (!name || !Number.isFinite(version) || version <= 0) return null;
  return { name, version };
}

export async function loadToolVersion(pool: Pool, tenantId: string, toolRef: string) {
  const res = await pool.query(
    `
      SELECT v.tool_ref, v.name, v.version, v.status, v.deps_digest, v.artifact_ref, v.trust_summary, v.scan_summary, v.sbom_digest, v.sbom_summary, v.input_schema, v.output_schema, d.risk_level, d.approval_required
      FROM tool_versions v
      LEFT JOIN tool_definitions d ON d.tenant_id = v.tenant_id AND d.name = v.name
      WHERE v.tenant_id = $1 AND v.tool_ref = $2 AND v.status = 'released'
      LIMIT 1
    `,
    [tenantId, toolRef],
  );
  if (res.rowCount === 0) return null;
  return res.rows[0] as any;
}

export function isWriteLeaseTool(toolName: string) {
  return toolName === "entity.create" || toolName === "entity.update" || toolName === "entity.delete" || toolName === "memory.write";
}

export function computeWriteLeaseResourceRef(params: { toolName: string; spaceId: string | null; idempotencyKey: string | null; toolInput: any }) {
  if (params.toolName === "memory.write") {
    if (!params.spaceId) return null;
    return `memory:${params.spaceId}`;
  }
  const entityName = String(params.toolInput?.entityName ?? "");
  if (!entityName) return null;
  if (params.toolName === "entity.update" || params.toolName === "entity.delete") {
    const id = String(params.toolInput?.id ?? "");
    if (!id) return null;
    return `entity:${entityName}:${id}`;
  }
  if (params.toolName === "entity.create") {
    const ik = String(params.idempotencyKey ?? "");
    if (!ik) return null;
    return `entity:${entityName}:create:${ik}`;
  }
  return null;
}
