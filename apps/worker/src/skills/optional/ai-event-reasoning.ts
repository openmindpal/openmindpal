/**
 * AI Event Reasoning — Worker-side contribution.
 *
 * Provides:
 * 1. A BullMQ job handler for async LLM event reasoning (Tier 3)
 * 2. A ticker that scans unprocessed events from channel_ingress_events
 *    and submits them to the reasoning pipeline via the API.
 *
 * The ticker picks up events that have no corresponding reasoning log yet,
 * calls the API's /governance/event-reasoning/reason endpoint,
 * and if the decision is "execute", enqueues the resulting action.
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";

/* ────────────────── Ticker: Scan and Submit Events ────────────────── */

/**
 * Scan recent channel_ingress_events that haven't been reasoned about yet,
 * and submit them to the reasoning pipeline.
 *
 * This uses a watermark pattern (like tickEvent.ts) to avoid reprocessing.
 * Events are submitted as BullMQ jobs for async processing.
 */
export async function tickEventReasoning(params: { pool: Pool; queue: Queue }) {
  // Check if AI event reasoning is enabled for any tenant
  const configRes = await params.pool.query(
    `SELECT DISTINCT tenant_id FROM event_reasoning_rules WHERE status = 'enabled' LIMIT 50`,
  );
  if (!configRes.rowCount) return; // No tenants have reasoning rules → skip

  const tenantIds = configRes.rows.map((r: any) => String(r.tenant_id));

  for (const tenantId of tenantIds) {
    await scanTenantEvents(params, tenantId);
  }
}

async function scanTenantEvents(params: { pool: Pool; queue: Queue }, tenantId: string) {
  // Get the watermark: last processed event timestamp for this tenant
  const wmRes = await params.pool.query(
    `SELECT MAX(created_at) AS last_at FROM event_reasoning_logs WHERE tenant_id = $1`,
    [tenantId],
  );
  const lastAt = wmRes.rows[0]?.last_at
    ? String(wmRes.rows[0].last_at)
    : "1970-01-01T00:00:00.000Z";

  // Fetch unprocessed events (events newer than last reasoning log)
  const evRes = await params.pool.query(
    `SELECT id, tenant_id, space_id, provider, workspace_id, event_id, body_json, created_at
     FROM channel_ingress_events
     WHERE tenant_id = $1 AND created_at > $2
     ORDER BY created_at ASC
     LIMIT 20`,
    [tenantId, lastAt],
  );

  for (const ev of evRes.rows as any[]) {
    const payload = ev.body_json ?? null;
    const eventType = payload && typeof payload === "object"
      ? String((payload as any).type ?? "unknown")
      : "unknown";

    // Check if this event was already reasoned about (idempotency)
    const existsRes = await params.pool.query(
      `SELECT 1 FROM event_reasoning_logs WHERE tenant_id = $1 AND event_source_id = $2 LIMIT 1`,
      [tenantId, String(ev.id)],
    );
    if (existsRes.rowCount) continue;

    // Enqueue for async reasoning
    await params.queue.add(
      "event.reasoning",
      {
        kind: "event.reasoning",
        tenantId,
        spaceId: ev.space_id ? String(ev.space_id) : null,
        eventSourceId: String(ev.id),
        eventType,
        provider: String(ev.provider ?? ""),
        workspaceId: String(ev.workspace_id ?? ""),
        payload,
      },
      {
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
        // Prevent duplicate processing
        jobId: `event-reasoning:${tenantId}:${ev.id}`,
      },
    );
  }
}

/* ────────────────── Job Handler: Process Reasoning ────────────────── */

/**
 * BullMQ job handler for event reasoning.
 *
 * This runs the reasoning pipeline by calling the reasoning engine directly
 * (via DB queries + model invocation), without going through the HTTP API.
 */
export async function processEventReasoningJob(params: {
  pool: Pool;
  queue: Queue;
  data: any;
}) {
  const d = params.data;
  const tenantId = String(d.tenantId ?? "");
  const spaceId = d.spaceId ? String(d.spaceId) : null;
  const eventSourceId = String(d.eventSourceId ?? "");
  const eventType = String(d.eventType ?? "unknown");
  const provider = String(d.provider ?? "");
  const workspaceId = String(d.workspaceId ?? "");
  const payload = d.payload ?? null;

  if (!tenantId || !eventSourceId) {
    console.warn("event.reasoning job: missing tenantId or eventSourceId, skipping");
    return;
  }

  // Idempotency: check if already processed
  const existsRes = await params.pool.query(
    `SELECT 1 FROM event_reasoning_logs WHERE tenant_id = $1 AND event_source_id = $2 LIMIT 1`,
    [tenantId, eventSourceId],
  );
  if (existsRes.rowCount) return;

  const startMs = Date.now();

  // ── Tier 1: Fast Rules ──
  const rulesRes = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1 AND status = 'enabled' AND tier = 'rule'
     ORDER BY priority ASC LIMIT 100`,
    [tenantId],
  );

  for (const rule of rulesRes.rows as any[]) {
    const matched = matchRuleSimple(rule, eventType, provider, payload);
    if (matched) {
      const latencyMs = Date.now() - startMs;
      await insertLog(params.pool, {
        tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
        payload, tier: "rule", decision: String(rule.decision ?? "execute"),
        confidence: 1.0, matchedRuleId: String(rule.rule_id),
        matchDigest: { ruleName: String(rule.name) },
        actionKind: rule.action_kind, actionRef: rule.action_ref,
        actionInput: rule.action_input_template,
        latencyMs,
      });

      // If decision is execute, enqueue the action
      if (String(rule.decision ?? "") === "execute" && rule.action_ref) {
        await enqueueAction(params, tenantId, spaceId, rule);
      }
      return;
    }
  }

  // ── Tier 2: Pattern Match ──
  const patternsRes = await params.pool.query(
    `SELECT * FROM event_reasoning_rules
     WHERE tenant_id = $1 AND status = 'enabled' AND tier = 'pattern'
     ORDER BY priority ASC LIMIT 50`,
    [tenantId],
  );

  for (const pattern of patternsRes.rows as any[]) {
    const matched = matchRuleSimple(pattern, eventType, provider, payload);
    if (matched) {
      const latencyMs = Date.now() - startMs;
      await insertLog(params.pool, {
        tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
        payload, tier: "pattern", decision: String(pattern.decision ?? "execute"),
        confidence: 0.85, matchedRuleId: String(pattern.rule_id),
        matchDigest: { patternName: String(pattern.name) },
        actionKind: pattern.action_kind, actionRef: pattern.action_ref,
        actionInput: pattern.action_input_template,
        latencyMs,
      });

      if (String(pattern.decision ?? "") === "execute" && pattern.action_ref) {
        await enqueueAction(params, tenantId, spaceId, pattern);
      }
      return;
    }
  }

  // ── Tier 3: No rule/pattern matched → log as "escalate" for LLM processing ──
  // LLM reasoning is handled by the API-side (routes.ts /reason endpoint)
  // Worker just marks it as needing escalation
  const latencyMs = Date.now() - startMs;
  await insertLog(params.pool, {
    tenantId, spaceId, eventSourceId, eventType, provider, workspaceId,
    payload, tier: "pattern", decision: "escalate",
    confidence: null, matchedRuleId: null,
    matchDigest: { reason: "no_rule_or_pattern_matched" },
    actionKind: null, actionRef: null, actionInput: null,
    latencyMs,
  });
}

/* ────────────────── Helpers ────────────────── */

function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchRuleSimple(
  rule: any,
  eventType: string,
  provider: string,
  _payload: any,
): boolean {
  const typePattern = rule.event_type_pattern ? String(rule.event_type_pattern) : null;
  if (typePattern && !globMatch(typePattern, eventType)) return false;

  const providerPattern = rule.provider_pattern ? String(rule.provider_pattern) : null;
  if (providerPattern && provider && !globMatch(providerPattern, provider)) return false;

  // Condition expression evaluation (simplified for worker side)
  const condExpr = rule.condition_expr;
  if (condExpr && typeof condExpr === "object") {
    // Basic condition: { path, op, value }
    if (typeof condExpr.path === "string" && _payload && typeof _payload === "object") {
      const segs = String(condExpr.path).split(".").filter(Boolean);
      let cur: any = _payload;
      for (const s of segs) {
        if (!cur || typeof cur !== "object") { cur = undefined; break; }
        cur = cur[s];
      }
      const op = String(condExpr.op ?? "eq");
      const expected = condExpr.value;
      if (op === "eq" && JSON.stringify(cur) !== JSON.stringify(expected)) return false;
      if (op === "neq" && JSON.stringify(cur) === JSON.stringify(expected)) return false;
      if (op === "gt" && !(Number(cur) > Number(expected))) return false;
      if (op === "gte" && !(Number(cur) >= Number(expected))) return false;
      if (op === "lt" && !(Number(cur) < Number(expected))) return false;
      if (op === "lte" && !(Number(cur) <= Number(expected))) return false;
      if (op === "exists" && (cur === undefined || cur === null)) return false;
    }
  }

  return true;
}

async function insertLog(pool: Pool, p: {
  tenantId: string; spaceId: string | null; eventSourceId: string;
  eventType: string; provider: string; workspaceId: string;
  payload: any; tier: string; decision: string;
  confidence: number | null; matchedRuleId: string | null;
  matchDigest: any; actionKind: string | null;
  actionRef: string | null; actionInput: any; latencyMs: number;
}) {
  await pool.query(
    `INSERT INTO event_reasoning_logs (
       tenant_id, space_id, event_source_id, event_type, provider, workspace_id,
       event_payload, tier, decision, confidence,
       action_kind, action_ref, action_input,
       matched_rule_id, match_digest, latency_ms
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16)`,
    [
      p.tenantId, p.spaceId, p.eventSourceId, p.eventType, p.provider, p.workspaceId,
      p.payload ? JSON.stringify(p.payload) : null,
      p.tier, p.decision, p.confidence,
      p.actionKind, p.actionRef,
      p.actionInput ? JSON.stringify(p.actionInput) : null,
      p.matchedRuleId, p.matchDigest ? JSON.stringify(p.matchDigest) : null,
      p.latencyMs,
    ],
  );
}

async function enqueueAction(
  params: { pool: Pool; queue: Queue },
  tenantId: string,
  spaceId: string | null,
  rule: any,
) {
  const actionKind = String(rule.action_kind ?? "");
  const actionRef = String(rule.action_ref ?? "");

  if (actionKind === "workflow" || actionKind === "tool") {
    // Create a job/run/step via SQL (similar to trigger runner)
    const jobType = actionKind === "workflow" ? "tool.execute" : actionRef;
    const input = rule.action_input_template ?? {};

    const jobRes = await params.pool.query(
      `INSERT INTO jobs (tenant_id, type, status) VALUES ($1, $2, 'pending') RETURNING job_id`,
      [tenantId, jobType],
    );
    const jobId = String(jobRes.rows[0].job_id);

    const runRes = await params.pool.query(
      `INSERT INTO runs (job_id, tenant_id, status) VALUES ($1, $2, 'pending') RETURNING run_id`,
      [jobId, tenantId],
    );
    const runId = String(runRes.rows[0].run_id);

    const stepRes = await params.pool.query(
      `INSERT INTO steps (run_id, tenant_id, seq, tool_ref, status, input)
       VALUES ($1, $2, 1, $3, 'pending', $4::jsonb) RETURNING step_id`,
      [runId, tenantId, actionRef, JSON.stringify({
        ...input,
        tenantId,
        spaceId,
        toolRef: actionRef,
        trigger: `ai-event-reasoning:${String(rule.rule_id)}`,
      })],
    );
    const stepId = String(stepRes.rows[0].step_id);

    await params.queue.add("step", { jobId, runId, stepId }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
    });
  }

  if (actionKind === "notify") {
    // Enqueue notification
    await params.pool.query(
      `INSERT INTO notification_outbox (tenant_id, template_ref, status, payload)
       VALUES ($1, $2, 'pending', $3::jsonb)
       ON CONFLICT DO NOTHING`,
      [tenantId, actionRef, JSON.stringify(rule.action_input_template ?? {})],
    );
  }
}
