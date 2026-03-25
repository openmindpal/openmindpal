import type { Pool } from "pg";

export type NotificationOutboxRow = {
  outboxId: string;
  tenantId: string;
  spaceId: string | null;
  channel: string;
  recipientRef: string;
  templateId: string;
  templateVersion: number;
  connectorInstanceId: string | null;
  locale: string;
  paramsDigest: any;
  status: string;
  deliveryStatus: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastErrorCategory: string | null;
  lastErrorDigest: any;
  deadletteredAt: string | null;
  contentCiphertext: any;
  createdAt: string;
  updatedAt: string;
  canceledAt: string | null;
};

function toRow(r: any): NotificationOutboxRow {
  return {
    outboxId: r.outbox_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    channel: r.channel,
    recipientRef: r.recipient_ref,
    templateId: r.template_id,
    templateVersion: Number(r.template_version),
    connectorInstanceId: r.connector_instance_id ?? null,
    locale: r.locale,
    paramsDigest: r.params_digest ?? null,
    status: r.status,
    deliveryStatus: r.delivery_status ?? r.status,
    attemptCount: Number(r.attempt_count ?? 0),
    nextAttemptAt: r.next_attempt_at ?? null,
    lastErrorCategory: r.last_error_category ?? null,
    lastErrorDigest: r.last_error_digest ?? null,
    deadletteredAt: r.deadlettered_at ?? null,
    contentCiphertext: r.content_ciphertext ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    canceledAt: r.canceled_at ?? null,
  };
}

export async function enqueueOutbox(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  channel: string;
  recipientRef: string;
  templateId: string;
  templateVersion: number;
  connectorInstanceId?: string | null;
  locale: string;
  paramsDigest?: any;
  contentCiphertext?: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO notification_outbox (tenant_id, space_id, channel, recipient_ref, template_id, template_version, connector_instance_id, locale, params_digest, content_ciphertext, status, delivery_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued','queued')
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.channel,
      params.recipientRef,
      params.templateId,
      params.templateVersion,
      params.connectorInstanceId ?? null,
      params.locale,
      params.paramsDigest ?? null,
      params.contentCiphertext ? JSON.stringify(params.contentCiphertext) : null,
    ],
  );
  return toRow(res.rows[0]);
}

export async function listOutbox(params: { pool: Pool; tenantId: string; spaceId: string | null; limit: number; offset: number }) {
  if (params.spaceId) {
    const res = await params.pool.query(
      `
        SELECT *
        FROM notification_outbox
        WHERE tenant_id = $1 AND space_id = $2
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `,
      [params.tenantId, params.spaceId, params.limit, params.offset],
    );
    return res.rows.map(toRow);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM notification_outbox
      WHERE tenant_id = $1 AND space_id IS NULL
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [params.tenantId, params.limit, params.offset],
  );
  return res.rows.map(toRow);
}

export async function cancelOutbox(params: { pool: Pool; tenantId: string; outboxId: string }) {
  const res = await params.pool.query(
    `
      UPDATE notification_outbox
      SET status = 'canceled', delivery_status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND outbox_id = $2 AND delivery_status = 'queued'
      RETURNING *
    `,
    [params.tenantId, params.outboxId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listOutboxByDeliveryStatus(params: { pool: Pool; tenantId: string; spaceId: string | null; deliveryStatus: string; limit: number }) {
  if (params.spaceId) {
    const res = await params.pool.query(
      `
        SELECT *
        FROM notification_outbox
        WHERE tenant_id = $1 AND space_id = $2 AND delivery_status = $3
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [params.tenantId, params.spaceId, params.deliveryStatus, params.limit],
    );
    return res.rows.map(toRow);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM notification_outbox
      WHERE tenant_id = $1 AND space_id IS NULL AND delivery_status = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.deliveryStatus, params.limit],
  );
  return res.rows.map(toRow);
}

export async function retryOutbox(params: { pool: Pool; tenantId: string; outboxId: string }) {
  const res = await params.pool.query(
    `
      UPDATE notification_outbox
      SET delivery_status = 'queued',
          status = 'queued',
          next_attempt_at = NULL,
          updated_at = now()
      WHERE tenant_id = $1 AND outbox_id = $2 AND delivery_status IN ('failed','deadletter')
      RETURNING *
    `,
    [params.tenantId, params.outboxId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function cancelOutboxByGovernance(params: { pool: Pool; tenantId: string; outboxId: string }) {
  const res = await params.pool.query(
    `
      UPDATE notification_outbox
      SET status = 'canceled',
          delivery_status = 'canceled',
          canceled_at = now(),
          updated_at = now()
      WHERE tenant_id = $1 AND outbox_id = $2 AND delivery_status IN ('queued','failed','deadletter')
      RETURNING *
    `,
    [params.tenantId, params.outboxId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
