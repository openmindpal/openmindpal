import type { Pool } from "pg";

export type UiComponentRegistryKey = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
};

export type UiComponentRegistryVersionRow = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  version: number;
  status: "draft" | "released";
  componentIds: string[];
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): UiComponentRegistryVersionRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    version: r.version,
    status: r.status,
    componentIds: Array.isArray(r.component_ids) ? r.component_ids.map((x: any) => String(x)) : [],
    createdBySubjectId: r.created_by_subject_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getUiComponentRegistryDraft(pool: Pool, key: UiComponentRegistryKey) {
  const res = await pool.query(
    `
      SELECT *
      FROM ui_component_registry_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'draft'
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getLatestReleasedUiComponentRegistry(pool: Pool, key: UiComponentRegistryKey) {
  const res = await pool.query(
    `
      SELECT *
      FROM ui_component_registry_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [key.tenantId, key.scopeType, key.scopeId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function upsertUiComponentRegistryDraft(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  componentIds: string[];
  createdBySubjectId: string;
}) {
  const componentIds = Array.from(new Set(params.componentIds.map((x) => String(x)).filter(Boolean))).slice(0, 2000);
  const res = await params.pool.query(
    `
      INSERT INTO ui_component_registry_versions (
        tenant_id, scope_type, scope_id, version, status, component_ids, created_by_subject_id
      )
      VALUES ($1,$2,$3,0,'draft',$4::jsonb,$5)
      ON CONFLICT (tenant_id, scope_type, scope_id, version)
      DO UPDATE SET
        component_ids = EXCLUDED.component_ids,
        created_by_subject_id = EXCLUDED.created_by_subject_id,
        updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, JSON.stringify(componentIds), params.createdBySubjectId],
  );
  return toRow(res.rows[0]);
}

export async function publishUiComponentRegistryFromDraft(params: { pool: Pool; key: UiComponentRegistryKey; createdBySubjectId: string; draft?: UiComponentRegistryVersionRow }) {
  const draft = params.draft ?? (await getUiComponentRegistryDraft(params.pool, params.key));
  if (!draft) return null;
  const latest = await params.pool.query(
    `
      SELECT version
      FROM ui_component_registry_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.key.tenantId, params.key.scopeType, params.key.scopeId],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const res = await params.pool.query(
    `
      INSERT INTO ui_component_registry_versions (
        tenant_id, scope_type, scope_id, version, status, component_ids, created_by_subject_id
      )
      VALUES ($1,$2,$3,$4,'released',$5::jsonb,$6)
      RETURNING *
    `,
    [params.key.tenantId, params.key.scopeType, params.key.scopeId, nextVersion, JSON.stringify(draft.componentIds ?? []), params.createdBySubjectId],
  );
  return toRow(res.rows[0]);
}

export async function rollbackUiComponentRegistryToPreviousReleased(params: { pool: Pool; key: UiComponentRegistryKey; createdBySubjectId: string }) {
  const prev = await params.pool.query(
    `
      SELECT *
      FROM ui_component_registry_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'released'
      ORDER BY version DESC
      OFFSET 1
      LIMIT 1
    `,
    [params.key.tenantId, params.key.scopeType, params.key.scopeId],
  );
  if (!prev.rowCount) return null;
  const prevRow = toRow(prev.rows[0]);
  const latest = await params.pool.query(
    `
      SELECT version
      FROM ui_component_registry_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.key.tenantId, params.key.scopeType, params.key.scopeId],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
  const res = await params.pool.query(
    `
      INSERT INTO ui_component_registry_versions (
        tenant_id, scope_type, scope_id, version, status, component_ids, created_by_subject_id
      )
      VALUES ($1,$2,$3,$4,'released',$5::jsonb,$6)
      RETURNING *
    `,
    [params.key.tenantId, params.key.scopeType, params.key.scopeId, nextVersion, JSON.stringify(prevRow.componentIds ?? []), params.createdBySubjectId],
  );
  return toRow(res.rows[0]);
}
