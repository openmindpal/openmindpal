import type { Pool, PoolClient } from "pg";
import { Errors } from "../../../lib/errors";
import type { WorkbenchCanaryConfigRow, WorkbenchPluginRow, WorkbenchPluginVersionRow, WorkbenchScope } from "./workbenchModel";
import { validateWorkbenchManifestV1 } from "./workbenchManifest";

type Q = Pool | PoolClient;

function rowToPlugin(r: any): WorkbenchPluginRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    workbenchKey: r.workbench_key,
    displayName: r.display_name,
    description: r.description,
    status: r.status,
    createdBySubjectId: r.created_by_subject_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToVersion(r: any): WorkbenchPluginVersionRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    workbenchKey: r.workbench_key,
    version: Number(r.version),
    status: r.status,
    artifactRef: r.artifact_ref,
    manifestJson: r.manifest_json,
    manifestDigest: r.manifest_digest,
    publishedAt: r.published_at,
    createdBySubjectId: r.created_by_subject_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToCanary(r: any): WorkbenchCanaryConfigRow {
  return {
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    workbenchKey: r.workbench_key,
    canaryVersion: Number(r.canary_version),
    canarySubjectIds: Array.isArray(r.canary_subject_ids) ? r.canary_subject_ids : [],
    updatedAt: r.updated_at,
  };
}

export async function ensureWorkbenchPlugin(params: WorkbenchScope & { pool: Q; workbenchKey: string; displayName?: any; description?: any; createdBySubjectId?: string | null }) {
  await params.pool.query(
    `
      INSERT INTO workbench_plugins (tenant_id, scope_type, scope_id, workbench_key, display_name, description, created_by_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, scope_type, scope_id, workbench_key) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, workbench_plugins.display_name),
          description = COALESCE(EXCLUDED.description, workbench_plugins.description),
          updated_at = now()
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.workbenchKey,
      params.displayName ? JSON.stringify(params.displayName) : null,
      params.description ? JSON.stringify(params.description) : null,
      params.createdBySubjectId ?? null,
    ],
  );
}

export async function getWorkbenchPlugin(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const res = await params.pool.query(
    "SELECT * FROM workbench_plugins WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  if (!res.rowCount) return null;
  return rowToPlugin(res.rows[0]);
}

export async function listWorkbenchPlugins(params: WorkbenchScope & { pool: Q }) {
  const res = await params.pool.query(
    `
      SELECT p.*,
        (
          SELECT row_to_json(v.*)
          FROM workbench_plugin_versions v
          WHERE v.tenant_id = p.tenant_id AND v.scope_type = p.scope_type AND v.scope_id = p.scope_id AND v.workbench_key = p.workbench_key AND v.status = 'released'
          ORDER BY v.version DESC
          LIMIT 1
        ) AS latest_released,
        (
          SELECT row_to_json(v.*)
          FROM workbench_plugin_versions v
          WHERE v.tenant_id = p.tenant_id AND v.scope_type = p.scope_type AND v.scope_id = p.scope_id AND v.workbench_key = p.workbench_key AND v.status = 'draft'
          LIMIT 1
        ) AS draft
      FROM workbench_plugins p
      WHERE p.tenant_id = $1 AND p.scope_type = $2 AND p.scope_id = $3
      ORDER BY p.workbench_key ASC
    `,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  return res.rows.map((r) => ({
    plugin: rowToPlugin(r),
    latestReleased: r.latest_released ? rowToVersion(r.latest_released) : null,
    draft: r.draft ? rowToVersion(r.draft) : null,
  }));
}

export async function upsertDraftVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; artifactRef: string; manifestJson: any; createdBySubjectId?: string | null }) {
  await ensureWorkbenchPlugin({ ...params, workbenchKey: params.workbenchKey, pool: params.pool, createdBySubjectId: params.createdBySubjectId ?? null });

  const { manifest, digest } = validateWorkbenchManifestV1(params.manifestJson);
  if (manifest.workbenchKey !== params.workbenchKey) throw Errors.workbenchManifestDenied("manifest.workbenchKey 与路径不一致");

  const res = await params.pool.query(
    `
      INSERT INTO workbench_plugin_versions (
        tenant_id, scope_type, scope_id, workbench_key, version, status, artifact_ref, manifest_json, manifest_digest, created_by_subject_id
      )
      VALUES ($1,$2,$3,$4,0,'draft',$5,$6,$7,$8)
      ON CONFLICT (tenant_id, scope_type, scope_id, workbench_key, version) DO UPDATE
      SET artifact_ref = EXCLUDED.artifact_ref,
          manifest_json = EXCLUDED.manifest_json,
          manifest_digest = EXCLUDED.manifest_digest,
          updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.workbenchKey,
      params.artifactRef,
      JSON.stringify(manifest),
      digest,
      params.createdBySubjectId ?? null,
    ],
  );
  return rowToVersion(res.rows[0]);
}

export async function getDraftVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM workbench_plugin_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'draft'
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  if (!res.rowCount) return null;
  return rowToVersion(res.rows[0]);
}

export async function getLatestReleasedVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM workbench_plugin_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  if (!res.rowCount) return null;
  return rowToVersion(res.rows[0]);
}

export async function publishFromDraft(params: WorkbenchScope & { pool: Q; workbenchKey: string; createdBySubjectId?: string | null }) {
  const draft = await getDraftVersion(params);
  if (!draft) return null;

  const latest = await params.pool.query(
    `
      SELECT version
      FROM workbench_plugin_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released'
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;

  const res = await params.pool.query(
    `
      INSERT INTO workbench_plugin_versions (
        tenant_id, scope_type, scope_id, workbench_key, version, status, artifact_ref, manifest_json, manifest_digest, created_by_subject_id
      )
      VALUES ($1,$2,$3,$4,$5,'released',$6,$7,$8,$9)
      RETURNING *
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.workbenchKey,
      nextVersion,
      draft.artifactRef,
      JSON.stringify(draft.manifestJson),
      draft.manifestDigest,
      params.createdBySubjectId ?? null,
    ],
  );

  await setActiveVersion({ ...params, activeVersion: nextVersion });
  return rowToVersion(res.rows[0]);
}

export async function getActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const res = await params.pool.query(
    "SELECT active_version FROM workbench_active_versions WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  if (!res.rowCount) return null;
  const v = Number(res.rows[0].active_version);
  return Number.isFinite(v) ? v : null;
}

export async function setActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; activeVersion: number }) {
  await params.pool.query(
    `
      INSERT INTO workbench_active_versions (tenant_id, scope_type, scope_id, workbench_key, active_version)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, scope_type, scope_id, workbench_key)
      DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey, params.activeVersion],
  );
}

export async function clearActiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  await params.pool.query("DELETE FROM workbench_active_versions WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4", [
    params.tenantId,
    params.scopeType,
    params.scopeId,
    params.workbenchKey,
  ]);
}

export async function getPreviousReleasedVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; beforeVersion: number }) {
  const res = await params.pool.query(
    `
      SELECT version
      FROM workbench_plugin_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released' AND version < $5
      ORDER BY version DESC
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey, params.beforeVersion],
  );
  if (!res.rowCount) return null;
  const v = Number(res.rows[0].version);
  return Number.isFinite(v) ? v : null;
}

export async function rollbackActiveToPreviousReleased(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const cur = await getActiveVersion(params);
  if (!cur) return null;
  const prev = await getPreviousReleasedVersion({ ...params, beforeVersion: cur });
  if (!prev) throw Errors.workbenchNoPreviousVersion();
  await setActiveVersion({ ...params, activeVersion: prev });
  return prev;
}

export async function getCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  const res = await params.pool.query(
    "SELECT * FROM workbench_canary_configs WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 LIMIT 1",
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey],
  );
  if (!res.rowCount) return null;
  return rowToCanary(res.rows[0]);
}

export async function setCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string; canaryVersion: number; subjectIds: string[] }) {
  const ids = Array.from(new Set(params.subjectIds.map((s) => String(s).trim()).filter(Boolean))).slice(0, 500);
  await params.pool.query(
    `
      INSERT INTO workbench_canary_configs (tenant_id, scope_type, scope_id, workbench_key, canary_version, canary_subject_ids)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, scope_type, scope_id, workbench_key)
      DO UPDATE SET canary_version = EXCLUDED.canary_version,
                    canary_subject_ids = EXCLUDED.canary_subject_ids,
                    updated_at = now()
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey, params.canaryVersion, JSON.stringify(ids)],
  );
}

export async function clearCanaryConfig(params: WorkbenchScope & { pool: Q; workbenchKey: string }) {
  await params.pool.query("DELETE FROM workbench_canary_configs WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4", [
    params.tenantId,
    params.scopeType,
    params.scopeId,
    params.workbenchKey,
  ]);
}

export async function resolveEffectiveVersion(params: WorkbenchScope & { pool: Q; workbenchKey: string; subjectId: string }) {
  const canary = await getCanaryConfig(params);
  if (canary && canary.canarySubjectIds.includes(params.subjectId)) return canary.canaryVersion;
  const active = await getActiveVersion(params);
  if (active) return active;
  const latest = await getLatestReleasedVersion(params);
  return latest?.version ?? null;
}

export async function getReleasedVersionByNumber(params: WorkbenchScope & { pool: Q; workbenchKey: string; version: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM workbench_plugin_versions
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released' AND version = $5
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.workbenchKey, params.version],
  );
  if (!res.rowCount) return null;
  return rowToVersion(res.rows[0]);
}
