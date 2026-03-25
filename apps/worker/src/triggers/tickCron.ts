import type { Pool } from "pg";
import * as cronParser from "cron-parser";
import type { Queue } from "bullmq";
import { fireCronTrigger, toTrigger, type TriggerDefinitionRow } from "./runner";

function parseIso(v: any) {
  const s = String(v ?? "");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function nextFromCron(expr: string, tz: string | null, from: Date) {
  const it = (cronParser as any).parseExpression(expr, { currentDate: from, tz: tz ?? "UTC" });
  const n = it.next();
  const d = typeof n?.toDate === "function" ? n.toDate() : new Date(n);
  return d;
}

export async function tickCronTriggers(params: { pool: Pool; queue: Queue }) {
  const candidates = await params.pool.query(
    `
      SELECT *
      FROM trigger_definitions
      WHERE status = 'enabled'
        AND type = 'cron'
        AND (next_fire_at IS NULL OR next_fire_at <= now())
      ORDER BY next_fire_at ASC NULLS FIRST, updated_at ASC
      LIMIT 20
    `,
  );

  for (const row of candidates.rows as any[]) {
    const trigger = (await params.pool.query("SELECT * FROM trigger_definitions WHERE trigger_id = $1 LIMIT 1", [row.trigger_id])).rows[0];
    if (!trigger) continue;
    const t = toTrigger(trigger);

    const now = new Date();
    const nextFireAtMs = t.nextFireAt ? parseIso(t.nextFireAt) : null;
    const scheduledAt = nextFireAtMs && t.cronMisfirePolicy === "catchup" ? new Date(nextFireAtMs).toISOString() : now.toISOString();

    if (!t.cronExpr) continue;
    let next: Date;
    try {
      next = nextFromCron(t.cronExpr, t.cronTz, now);
    } catch {
      await params.pool.query(
        "UPDATE trigger_definitions SET status = 'disabled', updated_at = now() WHERE trigger_id = $1",
        [t.triggerId],
      );
      continue;
    }

    const claimed = await params.pool.query(
      `
        UPDATE trigger_definitions
        SET next_fire_at = $2, last_run_at = now(), updated_at = now()
        WHERE trigger_id = $1 AND status = 'enabled' AND type = 'cron'
          AND (next_fire_at IS NULL OR next_fire_at <= now())
        RETURNING *
      `,
      [t.triggerId, next.toISOString()],
    );
    if (!claimed.rowCount) continue;

    const traceId = `trigger:${t.triggerId}:${Date.now()}`;
    await fireCronTrigger({ pool: params.pool, queue: params.queue, trigger: t, scheduledAt, traceId });
  }
}
