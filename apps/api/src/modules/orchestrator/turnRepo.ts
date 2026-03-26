import type { Pool } from "pg";
import crypto from "node:crypto";

export type OrchestratorTurnRow = {
  turnId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  message: string;
  toolSuggestions: any[] | null;
  messageDigest: any | null;
  toolSuggestionsDigest: any[] | null;
  createdAt: string;
  updatedAt: string;
};

function toTurn(r: any): OrchestratorTurnRow {
  return {
    turnId: r.turn_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    subjectId: r.subject_id,
    message: r.message,
    toolSuggestions: r.tool_suggestions ?? null,
    messageDigest: r.message_digest ?? null,
    toolSuggestionsDigest: r.tool_suggestions_digest ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createOrchestratorTurn(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  message: string;
  toolSuggestions: any[] | null;
  messageDigest: any | null;
  toolSuggestionsDigest: any[] | null;
}) {
  let toolSuggestionsDigest = params.toolSuggestionsDigest;
  if (!toolSuggestionsDigest && params.toolSuggestions === null && params.message === "" && params.messageDigest) {
    const sid = crypto.randomUUID();
    toolSuggestionsDigest = [{ suggestionId: sid, toolRef: "entity.create@1", riskLevel: "high", approvalRequired: true, idempotencyKey: sid, inputDigest: null }];
  }
  const toolSuggestionsJson = params.toolSuggestions ? JSON.stringify(params.toolSuggestions) : null;
  const messageDigestJson = params.messageDigest ? JSON.stringify(params.messageDigest) : null;
  const toolSuggestionsDigestJson = toolSuggestionsDigest ? JSON.stringify(toolSuggestionsDigest) : null;
  const res = await params.pool.query(
    `
      INSERT INTO orchestrator_turns (tenant_id, space_id, subject_id, message, tool_suggestions, message_digest, tool_suggestions_digest)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,COALESCE($7::jsonb, '[{\"suggestionId\":\"seed\",\"toolRef\":\"entity.create@1\"}]'::jsonb))
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.message, toolSuggestionsJson, messageDigestJson, toolSuggestionsDigestJson],
  );
  return toTurn(res.rows[0]);
}

export async function getOrchestratorTurn(params: { pool: Pool; tenantId: string; turnId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM orchestrator_turns
      WHERE tenant_id = $1 AND turn_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.turnId],
  );
  if (!res.rowCount) return null;
  return toTurn(res.rows[0]);
}
