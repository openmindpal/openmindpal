import type { Pool } from "pg";

export type NotificationTemplateVersionRow = {
  templateId: string;
  version: number;
  status: string;
  contentI18n: any;
  paramsSchema: any;
  createdAt: string;
  publishedAt: string | null;
};

function toRow(r: any): NotificationTemplateVersionRow {
  return {
    templateId: r.template_id,
    version: Number(r.version),
    status: r.status,
    contentI18n: r.content_i18n,
    paramsSchema: r.params_schema ?? null,
    createdAt: r.created_at,
    publishedAt: r.published_at ?? null,
  };
}

export async function createTemplateVersionDraft(params: { pool: Pool; templateId: string; version: number; contentI18n: any; paramsSchema?: any }) {
  const res = await params.pool.query(
    `
      INSERT INTO notification_template_versions (template_id, version, status, content_i18n, params_schema)
      VALUES ($1,$2,'draft',$3,$4)
      RETURNING *
    `,
    [params.templateId, params.version, params.contentI18n ?? {}, params.paramsSchema ?? null],
  );
  return toRow(res.rows[0]);
}

export async function getTemplateVersion(params: { pool: Pool; templateId: string; version: number }) {
  const res = await params.pool.query("SELECT * FROM notification_template_versions WHERE template_id = $1 AND version = $2 LIMIT 1", [params.templateId, params.version]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function publishTemplateVersion(params: { pool: Pool; templateId: string; version: number }) {
  const res = await params.pool.query(
    `
      UPDATE notification_template_versions
      SET status = 'released', published_at = now()
      WHERE template_id = $1 AND version = $2
      RETURNING *
    `,
    [params.templateId, params.version],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getLatestReleasedVersion(params: { pool: Pool; templateId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM notification_template_versions
      WHERE template_id = $1 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.templateId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

