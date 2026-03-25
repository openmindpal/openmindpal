import type { Pool } from "pg";

export type AuditSiemDestinationRow = {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  secretId: string;
  batchSize: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
};

export type AuditSiemDlqRow = {
  id: string;
  tenantId: string;
  destinationId: string;
  eventId: string;
  eventTs: string;
  attempts: number;
  lastErrorDigest: any;
  createdAt: string;
};

function toDest(r: any): AuditSiemDestinationRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    enabled: Boolean(r.enabled),
    secretId: String(r.secret_id),
    batchSize: Number(r.batch_size),
    timeoutMs: Number(r.timeout_ms),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toDlq(r: any): AuditSiemDlqRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    destinationId: String(r.destination_id),
    eventId: String(r.event_id),
    eventTs: String(r.event_ts),
    attempts: Number(r.attempts),
    lastErrorDigest: r.last_error_digest ?? null,
    createdAt: String(r.created_at),
  };
}

export async function listAuditSiemDestinations(params: { pool: Pool; tenantId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM audit_siem_destinations
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toDest);
}

export async function getAuditSiemDestination(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM audit_siem_destinations WHERE tenant_id = $1 AND id = $2 LIMIT 1`, [params.tenantId, params.id]);
  if (!res.rowCount) return null;
  return toDest(res.rows[0]);
}

export async function createAuditSiemDestination(params: {
  pool: Pool;
  tenantId: string;
  name: string;
  enabled: boolean;
  secretId: string;
  batchSize: number;
  timeoutMs: number;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO audit_siem_destinations (tenant_id, name, enabled, secret_id, batch_size, timeout_ms)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.name, params.enabled, params.secretId, params.batchSize, params.timeoutMs],
  );
  return toDest(res.rows[0]);
}

export async function updateAuditSiemDestination(params: {
  pool: Pool;
  tenantId: string;
  id: string;
  name: string;
  enabled: boolean;
  secretId: string;
  batchSize: number;
  timeoutMs: number;
}) {
  const res = await params.pool.query(
    `
      UPDATE audit_siem_destinations
      SET name = $3,
          enabled = $4,
          secret_id = $5,
          batch_size = $6,
          timeout_ms = $7,
          updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.name, params.enabled, params.secretId, params.batchSize, params.timeoutMs],
  );
  if (!res.rowCount) return null;
  return toDest(res.rows[0]);
}

export async function upsertAuditSiemCursor(params: { pool: Pool; tenantId: string; destinationId: string; lastTs: string | null; lastEventId: string | null }) {
  await params.pool.query(
    `
      INSERT INTO audit_siem_cursors (tenant_id, destination_id, last_ts, last_event_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, destination_id) DO UPDATE
      SET last_ts = EXCLUDED.last_ts,
          last_event_id = EXCLUDED.last_event_id,
          updated_at = now()
    `,
    [params.tenantId, params.destinationId, params.lastTs, params.lastEventId],
  );
  return { ok: true as const };
}

export async function clearAuditSiemOutbox(params: { pool: Pool; tenantId: string; destinationId: string }) {
  await params.pool.query(`DELETE FROM audit_siem_outbox WHERE tenant_id = $1 AND destination_id = $2`, [params.tenantId, params.destinationId]);
  await params.pool.query(`DELETE FROM audit_siem_dlq WHERE tenant_id = $1 AND destination_id = $2`, [params.tenantId, params.destinationId]);
  return { ok: true as const };
}

export async function listAuditSiemDlq(params: { pool: Pool; tenantId: string; destinationId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM audit_siem_dlq
      WHERE tenant_id = $1 AND destination_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.destinationId, params.limit],
  );
  return res.rows.map(toDlq);
}

export async function clearAuditSiemDlq(params: { pool: Pool; tenantId: string; destinationId: string }) {
  const res = await params.pool.query(`DELETE FROM audit_siem_dlq WHERE tenant_id = $1 AND destination_id = $2`, [params.tenantId, params.destinationId]);
  return { deletedCount: res.rowCount };
}

export async function requeueAuditSiemDlq(params: { pool: Pool; tenantId: string; destinationId: string; limit: number }) {
  const c = await params.pool.connect();
  try {
    await c.query("BEGIN");
    const res = await c.query(
      `
        SELECT id, tenant_id, destination_id, event_id, event_ts, payload
        FROM audit_siem_dlq
        WHERE tenant_id = $1 AND destination_id = $2
        ORDER BY created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      `,
      [params.tenantId, params.destinationId, params.limit],
    );
    if (!res.rowCount) {
      await c.query("COMMIT");
      return { requeuedCount: 0 };
    }
    for (const r of res.rows as any[]) {
      await c.query(
        `
          INSERT INTO audit_siem_outbox (tenant_id, destination_id, event_id, event_ts, payload, attempts, next_attempt_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,0,now())
          ON CONFLICT (tenant_id, destination_id, event_id) DO NOTHING
        `,
        [params.tenantId, params.destinationId, String(r.event_id), r.event_ts, JSON.stringify(r.payload)],
      );
    }
    const ids = res.rows.map((r: any) => String(r.id));
    await c.query(`DELETE FROM audit_siem_dlq WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [params.tenantId, ids]);
    await c.query("COMMIT");
    return { requeuedCount: ids.length };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
