import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { writeAudit } from "../workflow/processor/audit";

export type TriggerDefinitionRow = {
  triggerId: string;
  tenantId: string;
  spaceId: string | null;
  type: "cron" | "event";
  status: "enabled" | "disabled";
  cronExpr: string | null;
  cronTz: string | null;
  cronMisfirePolicy: string;
  nextFireAt: string | null;
  eventSource: string | null;
  eventFilter: any;
  eventWatermark: any;
  targetKind: "workflow" | "job";
  targetRef: string;
  inputMapping: any;
  idempotencyKeyTemplate: string | null;
  idempotencyWindowSec: number;
  rateLimitPerMin: number;
  lastRunAt: string | null;
  createdBySubjectId: string | null;
};

export function toTrigger(r: any): TriggerDefinitionRow {
  return {
    triggerId: String(r.trigger_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    type: r.type,
    status: r.status,
    cronExpr: r.cron_expr ?? null,
    cronTz: r.cron_tz ?? null,
    cronMisfirePolicy: String(r.cron_misfire_policy ?? "skip"),
    nextFireAt: r.next_fire_at ?? null,
    eventSource: r.event_source ?? null,
    eventFilter: r.event_filter_json ?? null,
    eventWatermark: r.event_watermark_json ?? null,
    targetKind: r.target_kind,
    targetRef: String(r.target_ref),
    inputMapping: r.input_mapping_json ?? null,
    idempotencyKeyTemplate: r.idempotency_key_template ?? null,
    idempotencyWindowSec: Number(r.idempotency_window_sec ?? 3600),
    rateLimitPerMin: Number(r.rate_limit_per_min ?? 60),
    lastRunAt: r.last_run_at ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function bucketStartIso(windowSec: number, date: Date) {
  const w = Math.max(1, Math.min(86400, Math.floor(windowSec)));
  const ms = date.getTime();
  const b = Math.floor(ms / (w * 1000)) * (w * 1000);
  return new Date(b).toISOString();
}

function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function safePath(path: unknown) {
  const raw = String(path ?? "").trim();
  if (!raw) return null;
  const segs = raw.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || segs.length > 12) return null;
  const ok = segs.every((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length <= 100);
  if (!ok) return null;
  return segs;
}

function getByPath(obj: any, path: string[]) {
  let cur: any = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}

function applyInputMapping(mapping: any, ctx: { scheduledAt: string; firedAt: string; trigger: TriggerDefinitionRow; event: any | null }) {
  if (!mapping) return { triggerId: ctx.trigger.triggerId, scheduledAt: ctx.scheduledAt, firedAt: ctx.firedAt, event: ctx.event };
  if (!isPlainObject(mapping)) throw new Error("trigger_input_mapping_invalid");
  const kind = String((mapping as any).kind ?? "");
  if (kind === "static") return (mapping as any).input ?? null;
  if (kind === "template") {
    const out: any = {};
    const fields = (mapping as any).fields;
    if (!isPlainObject(fields)) throw new Error("trigger_input_mapping_invalid");
    for (const [k, v] of Object.entries(fields)) {
      if (!isPlainObject(v)) throw new Error("trigger_input_mapping_invalid");
      const from = String((v as any).from ?? "");
      if (from === "const") {
        out[k] = (v as any).value;
        continue;
      }
      if (from === "time") {
        const key = String((v as any).key ?? "");
        if (key === "scheduledAt") out[k] = ctx.scheduledAt;
        else if (key === "firedAt") out[k] = ctx.firedAt;
        else if (key === "triggerId") out[k] = ctx.trigger.triggerId;
        else throw new Error("trigger_input_mapping_invalid");
        continue;
      }
      if (from === "event") {
        const p = safePath((v as any).path);
        if (!p) throw new Error("trigger_input_mapping_invalid");
        out[k] = ctx.event ? getByPath(ctx.event, p) : undefined;
        continue;
      }
      throw new Error("trigger_input_mapping_invalid");
    }
    return out;
  }
  throw new Error("trigger_input_mapping_invalid");
}

async function createJobRunStepLikeApi(params: {
  pool: Pool;
  tenantId: string;
  jobType: string;
  runToolRef: string;
  toolRef: string | null;
  trigger: string;
  createdBySubjectId: string | null;
  idempotencyKey: string | null;
  input: any;
}) {
  await params.pool.query("BEGIN");
  try {
    let runRes: any;
    if (params.idempotencyKey) {
      runRes = await params.pool.query(
        `
          INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
          VALUES ($1,'created',$2,$3,$4,$5,$6)
          ON CONFLICT (tenant_id, idempotency_key, tool_ref) WHERE idempotency_key IS NOT NULL AND tool_ref IS NOT NULL
          DO UPDATE SET updated_at = now()
          RETURNING *
        `,
        [params.tenantId, params.runToolRef, params.input ?? null, params.idempotencyKey, params.createdBySubjectId, params.trigger],
      );
      const runId = String(runRes.rows[0].run_id);
      const existing = await params.pool.query(
        `
          SELECT j.*, s.step_id AS first_step_id
          FROM jobs j
          JOIN steps s ON s.run_id = j.run_id AND s.seq = 1
          WHERE j.tenant_id = $1 AND j.run_id = $2
          ORDER BY j.created_at DESC
          LIMIT 1
        `,
        [params.tenantId, runId],
      );
      if (existing.rowCount) {
        await params.pool.query("COMMIT");
        const row = existing.rows[0] as any;
        return { jobId: String(row.job_id), runId, stepId: String(row.first_step_id) };
      }
    } else {
      runRes = await params.pool.query(
        `
          INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key, created_by_subject_id, trigger)
          VALUES ($1,'created',$2,$3,$4,$5,$6)
          RETURNING *
        `,
        [params.tenantId, params.runToolRef, params.input ?? null, null, params.createdBySubjectId, params.trigger],
      );
    }

    const runId = String(runRes.rows[0].run_id);
    const jobRes = await params.pool.query("INSERT INTO jobs (tenant_id, job_type, status, run_id) VALUES ($1,$2,'queued',$3) RETURNING *", [
      params.tenantId,
      params.jobType,
      runId,
    ]);
    const stepRes = await params.pool.query(
      `
        INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest)
        VALUES ($1, 1, 'pending', $2, $3, $4)
        RETURNING *
      `,
      [runId, params.toolRef, params.input ?? null, params.input ?? null],
    );
    await params.pool.query("COMMIT");
    return { jobId: String(jobRes.rows[0].job_id), runId, stepId: String(stepRes.rows[0].step_id) };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function fireCronTrigger(params: { pool: Pool; queue: Queue; trigger: TriggerDefinitionRow; scheduledAt: string; traceId: string }) {
  const trigger = params.trigger;
  const now = new Date();
  const scheduledAt = params.scheduledAt;
  const firedAt = nowIso();
  const vars: Record<string, string> = {
    triggerId: trigger.triggerId,
    tenantId: trigger.tenantId,
    spaceId: trigger.spaceId ?? "",
    scheduledAt,
    firedAt,
    bucketStart: bucketStartIso(trigger.idempotencyWindowSec, now),
  };
  const idempotencyKey = trigger.idempotencyKeyTemplate ? renderTemplate(trigger.idempotencyKeyTemplate, vars) : null;
  const triggerRunRes = await params.pool.query(
    `
      INSERT INTO trigger_runs (tenant_id, trigger_id, status, scheduled_at, fired_at, matched, match_reason, match_digest, idempotency_key, event_ref_json)
      VALUES ($1,$2,'queued',$3,$4,true,'cron', $5::jsonb, $6, NULL)
      ON CONFLICT (trigger_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING *
    `,
    [trigger.tenantId, trigger.triggerId, scheduledAt, firedAt, { type: "cron" }, idempotencyKey],
  );
  if (!triggerRunRes.rowCount) return { ok: true, deduped: true as const };

  try {
    const input = applyInputMapping(trigger.inputMapping, { scheduledAt, firedAt, trigger, event: null });
    const created = await createJobRunStepLikeApi({
      pool: params.pool,
      tenantId: trigger.tenantId,
      jobType: trigger.targetKind === "workflow" ? "tool.execute" : trigger.targetRef,
      runToolRef: trigger.targetKind === "workflow" ? trigger.targetRef : `trigger.job:${trigger.targetRef}`,
      toolRef: trigger.targetKind === "workflow" ? trigger.targetRef : null,
      trigger: `trigger:${trigger.triggerId}`,
      createdBySubjectId: trigger.createdBySubjectId,
      idempotencyKey,
      input,
    });
    await params.queue.add("step", { jobId: created.jobId, runId: created.runId, stepId: created.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await params.pool.query(
      `
        UPDATE trigger_runs
        SET status = 'succeeded', job_id = $3, run_id = $4, step_id = $5, updated_at = now()
        WHERE tenant_id = $1 AND trigger_run_id = $2
      `,
      [trigger.tenantId, String(triggerRunRes.rows[0].trigger_run_id), created.jobId, created.runId, created.stepId],
    );
    await writeAudit(params.pool, {
      traceId: params.traceId,
      tenantId: trigger.tenantId,
      spaceId: trigger.spaceId,
      subjectId: trigger.createdBySubjectId,
      runId: created.runId,
      stepId: created.stepId,
      resourceType: "trigger",
      action: "fire",
      result: "success",
      inputDigest: { triggerId: trigger.triggerId, type: "cron" },
      outputDigest: { triggerRunId: String(triggerRunRes.rows[0].trigger_run_id), jobId: created.jobId, runId: created.runId, stepId: created.stepId, idempotencyKey },
    });
    return { ok: true, deduped: false as const, runId: created.runId };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 1000);
    await params.pool.query(
      "UPDATE trigger_runs SET status = 'failed', last_error = $3, updated_at = now() WHERE tenant_id = $1 AND trigger_run_id = $2",
      [trigger.tenantId, String(triggerRunRes.rows[0].trigger_run_id), msg],
    );
    await writeAudit(params.pool, {
      traceId: params.traceId,
      tenantId: trigger.tenantId,
      spaceId: trigger.spaceId,
      subjectId: trigger.createdBySubjectId,
      resourceType: "trigger",
      action: "fire",
      result: "error",
      inputDigest: { triggerId: trigger.triggerId, type: "cron" },
      outputDigest: { triggerRunId: String(triggerRunRes.rows[0].trigger_run_id), error: msg },
      errorCategory: "trigger",
    });
    throw e;
  }
}

export async function fireEventTrigger(params: {
  pool: Pool;
  queue: Queue;
  trigger: TriggerDefinitionRow;
  scheduledAt: string;
  traceId: string;
  event: any;
  eventRef: any;
  matchReason: string;
  matched: boolean;
}) {
  const trigger = params.trigger;
  const now = new Date();
  const scheduledAt = params.scheduledAt;
  const firedAt = nowIso();
  const eventType = params.event?.eventType ? String(params.event.eventType) : "";
  const vars: Record<string, string> = {
    triggerId: trigger.triggerId,
    tenantId: trigger.tenantId,
    spaceId: trigger.spaceId ?? "",
    scheduledAt,
    firedAt,
    bucketStart: bucketStartIso(trigger.idempotencyWindowSec, now),
    eventId: params.event?.eventId ? String(params.event.eventId) : "",
    eventType,
    provider: params.event?.provider ? String(params.event.provider) : "",
    workspaceId: params.event?.workspaceId ? String(params.event.workspaceId) : "",
  };
  const idempotencyKey = trigger.idempotencyKeyTemplate ? renderTemplate(trigger.idempotencyKeyTemplate, vars) : null;

  const triggerRunRes = await params.pool.query(
    `
      INSERT INTO trigger_runs (tenant_id, trigger_id, status, scheduled_at, fired_at, matched, match_reason, match_digest, idempotency_key, event_ref_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
      ON CONFLICT (trigger_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING *
    `,
    [
      trigger.tenantId,
      trigger.triggerId,
      params.matched ? "queued" : "skipped",
      scheduledAt,
      firedAt,
      params.matched,
      params.matchReason,
      params.matched ? { source: trigger.eventSource, eventType } : { reason: params.matchReason },
      idempotencyKey,
      params.eventRef ?? null,
    ],
  );
  if (!triggerRunRes.rowCount) return { ok: true, deduped: true as const, matched: params.matched };
  if (!params.matched) return { ok: true, deduped: false as const, matched: false as const };

  try {
    const input = applyInputMapping(trigger.inputMapping, { scheduledAt, firedAt, trigger, event: params.event });
    const created = await createJobRunStepLikeApi({
      pool: params.pool,
      tenantId: trigger.tenantId,
      jobType: trigger.targetKind === "workflow" ? "tool.execute" : trigger.targetRef,
      runToolRef: trigger.targetKind === "workflow" ? trigger.targetRef : `trigger.job:${trigger.targetRef}`,
      toolRef: trigger.targetKind === "workflow" ? trigger.targetRef : null,
      trigger: `trigger:${trigger.triggerId}`,
      createdBySubjectId: trigger.createdBySubjectId,
      idempotencyKey,
      input,
    });
    await params.queue.add("step", { jobId: created.jobId, runId: created.runId, stepId: created.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await params.pool.query(
      `
        UPDATE trigger_runs
        SET status = 'succeeded', job_id = $3, run_id = $4, step_id = $5, updated_at = now()
        WHERE tenant_id = $1 AND trigger_run_id = $2
      `,
      [trigger.tenantId, String(triggerRunRes.rows[0].trigger_run_id), created.jobId, created.runId, created.stepId],
    );
    await writeAudit(params.pool, {
      traceId: params.traceId,
      tenantId: trigger.tenantId,
      spaceId: trigger.spaceId,
      subjectId: trigger.createdBySubjectId,
      runId: created.runId,
      stepId: created.stepId,
      resourceType: "trigger",
      action: "fire",
      result: "success",
      inputDigest: { triggerId: trigger.triggerId, type: "event", source: trigger.eventSource, matchReason: params.matchReason },
      outputDigest: { triggerRunId: String(triggerRunRes.rows[0].trigger_run_id), jobId: created.jobId, runId: created.runId, stepId: created.stepId, idempotencyKey },
    });
    return { ok: true, deduped: false as const, matched: true as const, runId: created.runId };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 1000);
    await params.pool.query(
      "UPDATE trigger_runs SET status = 'failed', last_error = $3, updated_at = now() WHERE tenant_id = $1 AND trigger_run_id = $2",
      [trigger.tenantId, String(triggerRunRes.rows[0].trigger_run_id), msg],
    );
    await writeAudit(params.pool, {
      traceId: params.traceId,
      tenantId: trigger.tenantId,
      spaceId: trigger.spaceId,
      subjectId: trigger.createdBySubjectId,
      resourceType: "trigger",
      action: "fire",
      result: "error",
      inputDigest: { triggerId: trigger.triggerId, type: "event", source: trigger.eventSource, matchReason: params.matchReason },
      outputDigest: { triggerRunId: String(triggerRunRes.rows[0].trigger_run_id), error: msg },
      errorCategory: "trigger",
    });
    throw e;
  }
}
