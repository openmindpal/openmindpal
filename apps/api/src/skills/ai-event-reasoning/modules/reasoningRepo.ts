/**
 * AI Event Reasoning — Database repository.
 *
 * CRUD for event_reasoning_rules and event_reasoning_logs tables.
 */
import type { Pool } from "pg";

/* ────────────────── Types ────────────────── */

export type EventReasoningRule = {
  ruleId: string;
  tenantId: string;
  spaceId: string | null;
  name: string;
  description: string | null;
  status: string;
  tier: string;
  priority: number;
  eventTypePattern: string | null;
  providerPattern: string | null;
  conditionExpr: any;
  decision: string;
  actionKind: string | null;
  actionRef: string | null;
  actionInputTemplate: any;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReasoningLogRow = {
  reasoningId: string;
  tenantId: string;
  spaceId: string | null;
  eventSourceId: string | null;
  eventType: string;
  provider: string | null;
  workspaceId: string | null;
  eventPayload: any;
  tier: string;
  decision: string;
  confidence: number | null;
  reasoningText: string | null;
  actionKind: string | null;
  actionRef: string | null;
  actionInput: any;
  runId: string | null;
  stepId: string | null;
  matchedRuleId: string | null;
  matchDigest: any;
  latencyMs: number | null;
  traceId: string | null;
  errorCategory: string | null;
  errorDigest: any;
  createdAt: string;
};

export type ReasoningLogInsert = {
  tenantId: string;
  spaceId: string | null;
  eventSourceId: string | null;
  eventType: string;
  provider: string | null;
  workspaceId: string | null;
  eventPayload: any;
  tier: string;
  decision: string;
  confidence: number | null;
  reasoningText: string | null;
  actionKind: string | null;
  actionRef: string | null;
  actionInput: any;
  matchedRuleId: string | null;
  matchDigest: any;
  latencyMs: number | null;
  traceId: string | null;
  errorCategory: string | null;
  errorDigest: any;
};

/* ────────────────── Row mappers ────────────────── */

function toRule(r: any): EventReasoningRule {
  return {
    ruleId: String(r.rule_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    status: String(r.status),
    tier: String(r.tier),
    priority: Number(r.priority ?? 100),
    eventTypePattern: r.event_type_pattern ? String(r.event_type_pattern) : null,
    providerPattern: r.provider_pattern ? String(r.provider_pattern) : null,
    conditionExpr: r.condition_expr ?? null,
    decision: String(r.decision ?? "execute"),
    actionKind: r.action_kind ? String(r.action_kind) : null,
    actionRef: r.action_ref ? String(r.action_ref) : null,
    actionInputTemplate: r.action_input_template ?? null,
    createdBySubjectId: r.created_by_subject_id ? String(r.created_by_subject_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toLog(r: any): ReasoningLogRow {
  return {
    reasoningId: String(r.reasoning_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    eventSourceId: r.event_source_id ? String(r.event_source_id) : null,
    eventType: String(r.event_type),
    provider: r.provider ? String(r.provider) : null,
    workspaceId: r.workspace_id ? String(r.workspace_id) : null,
    eventPayload: r.event_payload ?? null,
    tier: String(r.tier),
    decision: String(r.decision),
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reasoningText: r.reasoning_text ? String(r.reasoning_text) : null,
    actionKind: r.action_kind ? String(r.action_kind) : null,
    actionRef: r.action_ref ? String(r.action_ref) : null,
    actionInput: r.action_input ?? null,
    runId: r.run_id ? String(r.run_id) : null,
    stepId: r.step_id ? String(r.step_id) : null,
    matchedRuleId: r.matched_rule_id ? String(r.matched_rule_id) : null,
    matchDigest: r.match_digest ?? null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    traceId: r.trace_id ? String(r.trace_id) : null,
    errorCategory: r.error_category ? String(r.error_category) : null,
    errorDigest: r.error_digest ?? null,
    createdAt: String(r.created_at),
  };
}

/* ────────────────── Rules CRUD ────────────────── */

export async function listEnabledRules(params: { pool: Pool; tenantId: string; tier: string; limit: number }): Promise<EventReasoningRule[]> {
  const res = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1 AND status = 'enabled' AND tier = $2
     ORDER BY priority ASC, created_at ASC
     LIMIT $3`,
    [params.tenantId, params.tier, params.limit],
  );
  return res.rows.map(toRule);
}

export async function listAllRules(params: { pool: Pool; tenantId: string; limit: number }): Promise<EventReasoningRule[]> {
  const res = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1
     ORDER BY tier ASC, priority ASC, created_at ASC
     LIMIT $2`,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toRule);
}

export async function getRule(params: { pool: Pool; tenantId: string; ruleId: string }): Promise<EventReasoningRule | null> {
  const res = await params.pool.query(
    `SELECT * FROM event_reasoning_rules WHERE tenant_id = $1 AND rule_id = $2 LIMIT 1`,
    [params.tenantId, params.ruleId],
  );
  return res.rowCount ? toRule(res.rows[0]) : null;
}

export async function createRule(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  name: string;
  description: string | null;
  tier: string;
  priority: number;
  eventTypePattern: string | null;
  providerPattern: string | null;
  conditionExpr: any;
  decision: string;
  actionKind: string | null;
  actionRef: string | null;
  actionInputTemplate: any;
  createdBySubjectId: string | null;
}): Promise<EventReasoningRule> {
  const res = await params.pool.query(
    `INSERT INTO event_reasoning_rules (
       tenant_id, space_id, name, description, tier, priority,
       event_type_pattern, provider_pattern, condition_expr,
       decision, action_kind, action_ref, action_input_template,
       created_by_subject_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14)
     RETURNING *`,
    [
      params.tenantId, params.spaceId, params.name, params.description,
      params.tier, params.priority,
      params.eventTypePattern, params.providerPattern,
      params.conditionExpr ? JSON.stringify(params.conditionExpr) : null,
      params.decision, params.actionKind, params.actionRef,
      params.actionInputTemplate ? JSON.stringify(params.actionInputTemplate) : null,
      params.createdBySubjectId,
    ],
  );
  return toRule(res.rows[0]);
}

export async function updateRule(params: {
  pool: Pool;
  tenantId: string;
  ruleId: string;
  patch: {
    status?: string;
    description?: string;
    priority?: number;
    eventTypePattern?: string;
    providerPattern?: string;
    conditionExpr?: any;
    decision?: string;
    actionKind?: string;
    actionRef?: string;
    actionInputTemplate?: any;
  };
}): Promise<EventReasoningRule | null> {
  const sets: string[] = ["updated_at = now()"];
  const args: any[] = [params.tenantId, params.ruleId];
  let idx = 2;
  const p = params.patch;
  if (p.status !== undefined) { sets.push(`status = $${++idx}`); args.push(p.status); }
  if (p.description !== undefined) { sets.push(`description = $${++idx}`); args.push(p.description); }
  if (p.priority !== undefined) { sets.push(`priority = $${++idx}`); args.push(p.priority); }
  if (p.eventTypePattern !== undefined) { sets.push(`event_type_pattern = $${++idx}`); args.push(p.eventTypePattern); }
  if (p.providerPattern !== undefined) { sets.push(`provider_pattern = $${++idx}`); args.push(p.providerPattern); }
  if (p.conditionExpr !== undefined) { sets.push(`condition_expr = $${++idx}::jsonb`); args.push(JSON.stringify(p.conditionExpr)); }
  if (p.decision !== undefined) { sets.push(`decision = $${++idx}`); args.push(p.decision); }
  if (p.actionKind !== undefined) { sets.push(`action_kind = $${++idx}`); args.push(p.actionKind); }
  if (p.actionRef !== undefined) { sets.push(`action_ref = $${++idx}`); args.push(p.actionRef); }
  if (p.actionInputTemplate !== undefined) { sets.push(`action_input_template = $${++idx}::jsonb`); args.push(JSON.stringify(p.actionInputTemplate)); }

  const res = await params.pool.query(
    `UPDATE event_reasoning_rules SET ${sets.join(", ")} WHERE tenant_id = $1 AND rule_id = $2 RETURNING *`,
    args,
  );
  return res.rowCount ? toRule(res.rows[0]) : null;
}

/* ────────────────── Reasoning Logs ────────────────── */

export async function insertReasoningLog(params: { pool: Pool; log: ReasoningLogInsert }): Promise<ReasoningLogRow> {
  const l = params.log;
  const res = await params.pool.query(
    `INSERT INTO event_reasoning_logs (
       tenant_id, space_id, event_source_id, event_type, provider, workspace_id,
       event_payload, tier, decision, confidence, reasoning_text,
       action_kind, action_ref, action_input,
       matched_rule_id, match_digest,
       latency_ms, trace_id, error_category, error_digest
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18,$19,$20::jsonb)
     RETURNING *`,
    [
      l.tenantId, l.spaceId, l.eventSourceId, l.eventType, l.provider, l.workspaceId,
      l.eventPayload ? JSON.stringify(l.eventPayload) : null,
      l.tier, l.decision, l.confidence, l.reasoningText,
      l.actionKind, l.actionRef,
      l.actionInput ? JSON.stringify(l.actionInput) : null,
      l.matchedRuleId, l.matchDigest ? JSON.stringify(l.matchDigest) : null,
      l.latencyMs, l.traceId, l.errorCategory,
      l.errorDigest ? JSON.stringify(l.errorDigest) : null,
    ],
  );
  return toLog(res.rows[0]);
}

export async function listReasoningLogs(params: {
  pool: Pool;
  tenantId: string;
  limit: number;
  decision?: string;
}): Promise<ReasoningLogRow[]> {
  if (params.decision) {
    const res = await params.pool.query(
      `SELECT * FROM event_reasoning_logs
       WHERE tenant_id = $1 AND decision = $2
       ORDER BY created_at DESC LIMIT $3`,
      [params.tenantId, params.decision, params.limit],
    );
    return res.rows.map(toLog);
  }
  const res = await params.pool.query(
    `SELECT * FROM event_reasoning_logs
     WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toLog);
}

export async function getReasoningLog(params: { pool: Pool; tenantId: string; reasoningId: string }): Promise<ReasoningLogRow | null> {
  const res = await params.pool.query(
    `SELECT * FROM event_reasoning_logs WHERE tenant_id = $1 AND reasoning_id = $2 LIMIT 1`,
    [params.tenantId, params.reasoningId],
  );
  return res.rowCount ? toLog(res.rows[0]) : null;
}

export async function updateReasoningLogAction(params: {
  pool: Pool;
  tenantId: string;
  reasoningId: string;
  runId: string | null;
  stepId: string | null;
}): Promise<void> {
  await params.pool.query(
    `UPDATE event_reasoning_logs SET run_id = $3, step_id = $4, updated_at = now() WHERE tenant_id = $1 AND reasoning_id = $2`,
    [params.tenantId, params.reasoningId, params.runId, params.stepId],
  );
}
