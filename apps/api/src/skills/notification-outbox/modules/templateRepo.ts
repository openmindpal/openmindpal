import type { Pool } from "pg";

export type NotificationTemplateRow = {
  templateId: string;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  key: string;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): NotificationTemplateRow {
  return {
    templateId: r.template_id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    key: r.key,
    channel: r.channel,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createNotificationTemplate(params: { pool: Pool; tenantId: string; scopeType: string; scopeId: string; key: string; channel: string }) {
  const res = await params.pool.query(
    `
      INSERT INTO notification_templates (tenant_id, scope_type, scope_id, key, channel, status)
      VALUES ($1,$2,$3,$4,$5,'active')
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.key, params.channel],
  );
  return toRow(res.rows[0]);
}

export async function getNotificationTemplate(params: { pool: Pool; tenantId: string; templateId: string }) {
  const res = await params.pool.query("SELECT * FROM notification_templates WHERE tenant_id = $1 AND template_id = $2 LIMIT 1", [params.tenantId, params.templateId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function setNotificationTemplateStatus(params: { pool: Pool; tenantId: string; templateId: string; status: "active" | "disabled" }) {
  const res = await params.pool.query(
    `
      UPDATE notification_templates
      SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND template_id = $2
      RETURNING *
    `,
    [params.tenantId, params.templateId, params.status],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

