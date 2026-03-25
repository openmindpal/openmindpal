import type { Pool } from "pg";
import type { PageDraft } from "./pageModel";

export type PageKey = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  name: string;
};

export type PageVersionRow = {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  name: string;
  version: number;
  status: string;
  pageType: string;
  title: any;
  params: any;
  dataBindings: any;
  actionBindings: any;
  ui: any;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
};

function rowToPageVersion(r: any): PageVersionRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    name: r.name,
    version: r.version,
    status: r.status,
    pageType: r.page_type,
    title: r.title,
    params: r.params,
    dataBindings: r.data_bindings,
    actionBindings: r.action_bindings,
    ui: r.ui_json,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function ensurePageTemplate(pool: Pool, key: PageKey) {
  await pool.query(
    `
      INSERT INTO page_templates (tenant_id, scope_type, scope_id, name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, scope_type, scope_id, name) DO UPDATE
      SET updated_at = now()
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
}

export async function upsertDraft(pool: Pool, key: PageKey, draft: PageDraft) {
  await ensurePageTemplate(pool, key);
  const res = await pool.query(
    `
      INSERT INTO page_template_versions (
        tenant_id, scope_type, scope_id, name, version, status, page_type, title, params, data_bindings, action_bindings, ui_json
      )
      VALUES ($1, $2, $3, $4, 0, 'draft', $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, scope_type, scope_id, name, version) DO UPDATE
      SET page_type = EXCLUDED.page_type,
          title = EXCLUDED.title,
          params = EXCLUDED.params,
          data_bindings = EXCLUDED.data_bindings,
          action_bindings = EXCLUDED.action_bindings,
          ui_json = EXCLUDED.ui_json,
          updated_at = now()
      RETURNING *
    `,
    [
      key.tenantId,
      key.scopeType,
      key.scopeId,
      key.name,
      draft.pageType,
      draft.title ? JSON.stringify(draft.title) : null,
      draft.params ? JSON.stringify(draft.params) : null,
      draft.dataBindings ? JSON.stringify(draft.dataBindings) : null,
      draft.actionBindings ? JSON.stringify(draft.actionBindings) : null,
      (draft as any).ui ? JSON.stringify((draft as any).ui) : null,
    ],
  );
  return rowToPageVersion(res.rows[0]);
}

export async function getDraft(pool: Pool, key: PageKey) {
  const res = await pool.query(
    `
      SELECT *
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'draft'
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  if (res.rowCount === 0) return null;
  return rowToPageVersion(res.rows[0]);
}

export async function listPages(pool: Pool, tenantId: string, scopeType: "tenant" | "space", scopeId: string) {
  const res = await pool.query(
    `
      SELECT t.name,
        (
          SELECT row_to_json(v.*)
          FROM page_template_versions v
          WHERE v.tenant_id = t.tenant_id AND v.scope_type = t.scope_type AND v.scope_id = t.scope_id AND v.name = t.name AND v.status = 'released'
          ORDER BY v.version DESC
          LIMIT 1
        ) AS latest_released,
        (
          SELECT row_to_json(v.*)
          FROM page_template_versions v
          WHERE v.tenant_id = t.tenant_id AND v.scope_type = t.scope_type AND v.scope_id = t.scope_id AND v.name = t.name AND v.status = 'draft'
          LIMIT 1
        ) AS draft
      FROM page_templates t
      WHERE t.tenant_id = $1 AND t.scope_type = $2 AND t.scope_id = $3
      ORDER BY t.name ASC
    `,
    [tenantId, scopeType, scopeId],
  );

  return res.rows.map((r) => ({
    name: r.name as string,
    latestReleased: r.latest_released ? rowToPageVersion(r.latest_released) : null,
    draft: r.draft ? rowToPageVersion(r.draft) : null,
  }));
}

export async function getLatestReleased(pool: Pool, key: PageKey) {
  const res = await pool.query(
    `
      SELECT *
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  if (res.rowCount === 0) return null;
  return rowToPageVersion(res.rows[0]);
}

export async function publishFromDraft(pool: Pool, key: PageKey) {
  const draft = await getDraft(pool, key);
  if (!draft) return null;
  const latest = await pool.query(
    `
      SELECT version
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const res = await pool.query(
    `
      INSERT INTO page_template_versions (
        tenant_id, scope_type, scope_id, name, version, status, page_type, title, params, data_bindings, action_bindings, ui_json
      )
      VALUES ($1, $2, $3, $4, $5, 'released', $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      key.tenantId,
      key.scopeType,
      key.scopeId,
      key.name,
      nextVersion,
      draft.pageType,
      draft.title ? JSON.stringify(draft.title) : null,
      draft.params ? JSON.stringify(draft.params) : null,
      draft.dataBindings ? JSON.stringify(draft.dataBindings) : null,
      draft.actionBindings ? JSON.stringify(draft.actionBindings) : null,
      (draft as any).ui ? JSON.stringify((draft as any).ui) : null,
    ],
  );
  return rowToPageVersion(res.rows[0]);
}

export async function rollbackToPreviousReleased(pool: Pool, key: PageKey) {
  const prev = await pool.query(
    `
      SELECT *
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released'
      ORDER BY version DESC
      OFFSET 1
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  if (prev.rowCount === 0) return null;
  const prevRow = rowToPageVersion(prev.rows[0]);
  const latest = await pool.query(
    `
      SELECT version
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const res = await pool.query(
    `
      INSERT INTO page_template_versions (
        tenant_id, scope_type, scope_id, name, version, status, page_type, title, params, data_bindings, action_bindings, ui_json
      )
      VALUES ($1, $2, $3, $4, $5, 'released', $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      key.tenantId,
      key.scopeType,
      key.scopeId,
      key.name,
      nextVersion,
      prevRow.pageType,
      prevRow.title ? JSON.stringify(prevRow.title) : null,
      prevRow.params ? JSON.stringify(prevRow.params) : null,
      prevRow.dataBindings ? JSON.stringify(prevRow.dataBindings) : null,
      prevRow.actionBindings ? JSON.stringify(prevRow.actionBindings) : null,
      prevRow.ui ? JSON.stringify(prevRow.ui) : null,
    ],
  );
  return rowToPageVersion(res.rows[0]);
}

export async function cloneReleasedVersion(pool: Pool, key: PageKey, sourceVersion: number) {
  const src = await pool.query(
    `
      SELECT *
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released' AND version = $5
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name, sourceVersion],
  );
  if (!src.rowCount) return null;
  const srcRow = rowToPageVersion(src.rows[0]);
  const latest = await pool.query(
    `
      SELECT version
      FROM page_template_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const res = await pool.query(
    `
      INSERT INTO page_template_versions (
        tenant_id, scope_type, scope_id, name, version, status, page_type, title, params, data_bindings, action_bindings, ui_json
      )
      VALUES ($1, $2, $3, $4, $5, 'released', $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    [
      key.tenantId,
      key.scopeType,
      key.scopeId,
      key.name,
      nextVersion,
      srcRow.pageType,
      srcRow.title ? JSON.stringify(srcRow.title) : null,
      srcRow.params ? JSON.stringify(srcRow.params) : null,
      srcRow.dataBindings ? JSON.stringify(srcRow.dataBindings) : null,
      srcRow.actionBindings ? JSON.stringify(srcRow.actionBindings) : null,
      srcRow.ui ? JSON.stringify(srcRow.ui) : null,
    ],
  );
  return rowToPageVersion(res.rows[0]);
}

export async function setPageVersionStatus(pool: Pool, key: PageKey, version: number, status: string) {
  await pool.query(
    `
      UPDATE page_template_versions
      SET status = $6, updated_at = now()
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4 AND version = $5
    `,
    [key.tenantId, key.scopeType, key.scopeId, key.name, version, status],
  );
}

export async function deletePage(pool: Pool, key: PageKey) {
  await pool.query(
    `DELETE FROM page_template_versions WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4`,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  const res = await pool.query(
    `DELETE FROM page_templates WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = $4`,
    [key.tenantId, key.scopeType, key.scopeId, key.name],
  );
  return (res.rowCount ?? 0) > 0;
}
