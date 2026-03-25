import type { Pool, PoolClient } from "pg";
import { insertAuditEvent, type AuditEventInput } from "./auditRepo";

type Q = Pool | PoolClient;

export async function enqueueAuditOutbox(params: { db: Q; tenantId: string; spaceId?: string; event: AuditEventInput }) {
  if (process.env.AUDIT_OUTBOX_FORCE_FAIL === "1") throw new Error("audit_outbox_force_fail");
  const res = await params.db.query(
    `
      INSERT INTO audit_outbox (tenant_id, space_id, event)
      VALUES ($1, $2, $3::jsonb)
      RETURNING outbox_id
    `,
    [params.tenantId, params.spaceId ?? null, JSON.stringify(params.event)],
  );
  return { outboxId: String(res.rows[0].outbox_id) };
}

function backoffMs(attempt: number) {
  const base = 200;
  const max = 30_000;
  const pow = Math.min(8, Math.max(0, attempt));
  return Math.min(max, base * 2 ** pow);
}

export async function dispatchAuditOutboxBatch(params: { pool: Pool; limit?: number }) {
  const limit = params.limit ?? 50;
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `
        SELECT outbox_id, tenant_id, space_id, event, attempt
        FROM audit_outbox
        WHERE status IN ('queued','failed')
          AND next_attempt_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [limit],
    );
    await client.query(
      `
        UPDATE audit_outbox
        SET status = 'processing', locked_at = now()
        WHERE outbox_id = ANY($1::uuid[])
      `,
      [res.rows.map((r) => r.outbox_id)],
    );
    await client.query("COMMIT");

    let ok = 0;
    let failed = 0;

    for (const r of res.rows) {
      const outboxId = String(r.outbox_id);
      const attempt = Number(r.attempt ?? 0);
      const event = (r.event ?? null) as any;
      try {
        await insertAuditEvent(params.pool, { ...(event as any), outboxId });
        await params.pool.query("UPDATE audit_outbox SET status = 'succeeded' WHERE outbox_id = $1", [outboxId]);
        ok += 1;
      } catch (e: any) {
        if (String(e?.code ?? "") === "23505") {
          await params.pool.query("UPDATE audit_outbox SET status = 'succeeded' WHERE outbox_id = $1", [outboxId]);
          ok += 1;
          continue;
        }
        const nextAt = new Date(Date.now() + backoffMs(attempt + 1)).toISOString();
        const msg = String(e?.message ?? e ?? "dispatch_failed").slice(0, 500);
        await params.pool.query(
          "UPDATE audit_outbox SET status = 'failed', attempt = attempt + 1, last_error = $2, next_attempt_at = $3 WHERE outbox_id = $1",
          [outboxId, msg, nextAt],
        );
        failed += 1;
      }
    }

    return { claimed: res.rows.length, ok, failed };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw e;
  } finally {
    client.release();
  }
}
