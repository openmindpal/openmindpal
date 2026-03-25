import type { Pool } from "pg";
import * as cronParser from "cron-parser";

export type TriggerRow = {
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
  createdAt: string;
  updatedAt: string;
};

export type TriggerRunRow = {
  triggerRunId: string;
  tenantId: string;
  triggerId: string;
  status: string;
  scheduledAt: string | null;
  firedAt: string | null;
  matched: boolean | null;
  matchReason: string | null;
  matchDigest: any;
  idempotencyKey: string | null;
  eventRef: any;
  jobId: string | null;
  runId: string | null;
  stepId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function toTrigger(r: any): TriggerRow {
  return {
    triggerId: r.trigger_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    type: r.type,
    status: r.status,
    cronExpr: r.cron_expr ?? null,
    cronTz: r.cron_tz ?? null,
    cronMisfirePolicy: r.cron_misfire_policy ?? "skip",
    nextFireAt: r.next_fire_at ?? null,
    eventSource: r.event_source ?? null,
    eventFilter: r.event_filter_json ?? null,
    eventWatermark: r.event_watermark_json ?? null,
    targetKind: r.target_kind,
    targetRef: r.target_ref,
    inputMapping: r.input_mapping_json ?? null,
    idempotencyKeyTemplate: r.idempotency_key_template ?? null,
    idempotencyWindowSec: Number(r.idempotency_window_sec ?? 3600),
    rateLimitPerMin: Number(r.rate_limit_per_min ?? 60),
    lastRunAt: r.last_run_at ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTriggerRun(r: any): TriggerRunRow {
  return {
    triggerRunId: r.trigger_run_id,
    tenantId: r.tenant_id,
    triggerId: r.trigger_id,
    status: r.status,
    scheduledAt: r.scheduled_at ?? null,
    firedAt: r.fired_at ?? null,
    matched: r.matched ?? null,
    matchReason: r.match_reason ?? null,
    matchDigest: r.match_digest ?? null,
    idempotencyKey: r.idempotency_key ?? null,
    eventRef: r.event_ref_json ?? null,
    jobId: r.job_id ?? null,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function computeCronNextFireAt(params: { cronExpr: string; tz?: string | null; from?: Date }) {
  const from = params.from ?? new Date();
  const it = (cronParser as any).parseExpression(params.cronExpr, { currentDate: from, tz: params.tz ?? "UTC" });
  const n = it.next();
  const d = typeof n?.toDate === "function" ? n.toDate() : new Date(n);
  return d.toISOString();
}

export async function createTrigger(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  type: "cron" | "event";
  status: "enabled" | "disabled";
  cronExpr: string | null;
  cronTz: string | null;
  cronMisfirePolicy: string;
  eventSource: string | null;
  eventFilter: any;
  targetKind: "workflow" | "job";
  targetRef: string;
  inputMapping: any;
  idempotencyKeyTemplate: string | null;
  idempotencyWindowSec: number;
  rateLimitPerMin: number;
  createdBySubjectId: string;
}) {
  const nextFireAt =
    params.type === "cron" && params.status === "enabled" && params.cronExpr
      ? computeCronNextFireAt({ cronExpr: params.cronExpr, tz: params.cronTz ?? "UTC" })
      : null;
  const res = await params.pool.query(
    `
      INSERT INTO trigger_definitions (
        tenant_id, space_id, type, status,
        cron_expr, cron_tz, cron_misfire_policy, next_fire_at,
        event_source, event_filter_json, event_watermark_json,
        target_kind, target_ref, input_mapping_json,
        idempotency_key_template, idempotency_window_sec, rate_limit_per_min,
        created_by_subject_id
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10::jsonb,$11::jsonb,
        $12,$13,$14::jsonb,
        $15,$16,$17,
        $18
      )
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.type,
      params.status,
      params.cronExpr,
      params.cronTz ?? "UTC",
      params.cronMisfirePolicy ?? "skip",
      nextFireAt,
      params.eventSource,
      params.eventFilter ?? null,
      null,
      params.targetKind,
      params.targetRef,
      params.inputMapping ?? null,
      params.idempotencyKeyTemplate,
      params.idempotencyWindowSec,
      params.rateLimitPerMin,
      params.createdBySubjectId,
    ],
  );
  return toTrigger(res.rows[0]);
}

export async function updateTrigger(params: {
  pool: Pool;
  tenantId: string;
  triggerId: string;
  patch: Partial<{
    spaceId: string | null;
    status: "enabled" | "disabled";
    cronExpr: string | null;
    cronTz: string | null;
    cronMisfirePolicy: string;
    eventSource: string | null;
    eventFilter: any;
    targetKind: "workflow" | "job";
    targetRef: string;
    inputMapping: any;
    idempotencyKeyTemplate: string | null;
    idempotencyWindowSec: number;
    rateLimitPerMin: number;
  }>;
}) {
  const existing = await getTrigger({ pool: params.pool, tenantId: params.tenantId, triggerId: params.triggerId });
  if (!existing) return null;
  const nextCronExpr = params.patch.cronExpr !== undefined ? params.patch.cronExpr : existing.cronExpr;
  const nextCronTz = params.patch.cronTz !== undefined ? params.patch.cronTz : existing.cronTz;
  const nextStatus = params.patch.status !== undefined ? params.patch.status : existing.status;
  const nextFireAt =
    existing.type === "cron"
      ? nextStatus === "enabled" && nextCronExpr
        ? computeCronNextFireAt({ cronExpr: nextCronExpr, tz: nextCronTz ?? "UTC" })
        : null
      : existing.nextFireAt;

  const res = await params.pool.query(
    `
      UPDATE trigger_definitions
      SET
        space_id = COALESCE($3, space_id),
        status = COALESCE($4, status),
        cron_expr = COALESCE($5, cron_expr),
        cron_tz = COALESCE($6, cron_tz),
        cron_misfire_policy = COALESCE($7, cron_misfire_policy),
        next_fire_at = $8,
        event_source = COALESCE($9, event_source),
        event_filter_json = COALESCE($10::jsonb, event_filter_json),
        target_kind = COALESCE($11, target_kind),
        target_ref = COALESCE($12, target_ref),
        input_mapping_json = COALESCE($13::jsonb, input_mapping_json),
        idempotency_key_template = COALESCE($14, idempotency_key_template),
        idempotency_window_sec = COALESCE($15, idempotency_window_sec),
        rate_limit_per_min = COALESCE($16, rate_limit_per_min),
        updated_at = now()
      WHERE tenant_id = $1 AND trigger_id = $2
      RETURNING *
    `,
    [
      params.tenantId,
      params.triggerId,
      params.patch.spaceId ?? null,
      params.patch.status ?? null,
      params.patch.cronExpr ?? null,
      params.patch.cronTz ?? null,
      params.patch.cronMisfirePolicy ?? null,
      nextFireAt,
      params.patch.eventSource ?? null,
      params.patch.eventFilter ?? null,
      params.patch.targetKind ?? null,
      params.patch.targetRef ?? null,
      params.patch.inputMapping ?? null,
      params.patch.idempotencyKeyTemplate ?? null,
      params.patch.idempotencyWindowSec ?? null,
      params.patch.rateLimitPerMin ?? null,
    ],
  );
  if (!res.rowCount) return null;
  return toTrigger(res.rows[0]);
}

export async function getTrigger(params: { pool: Pool; tenantId: string; triggerId: string }) {
  const res = await params.pool.query("SELECT * FROM trigger_definitions WHERE tenant_id = $1 AND trigger_id = $2 LIMIT 1", [params.tenantId, params.triggerId]);
  if (!res.rowCount) return null;
  return toTrigger(res.rows[0]);
}

export async function listTriggers(params: { pool: Pool; tenantId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM trigger_definitions
      WHERE tenant_id = $1
      ORDER BY updated_at DESC
      LIMIT $2
    `,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toTrigger);
}

export async function listTriggerRuns(params: { pool: Pool; tenantId: string; triggerId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM trigger_runs
      WHERE tenant_id = $1 AND trigger_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.triggerId, params.limit],
  );
  return res.rows.map(toTriggerRun);
}
