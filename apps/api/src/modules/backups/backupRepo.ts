import type { Pool } from "pg";

export type BackupRow = {
  backupId: string;
  tenantId: string;
  spaceId: string;
  status: string;
  scope: string;
  schemaName: string;
  entityNames: string[] | null;
  format: string;
  backupArtifactId: string | null;
  reportArtifactId: string | null;
  policySnapshotRef: string | null;
  runId: string | null;
  stepId: string | null;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toBackup(r: any): BackupRow {
  return {
    backupId: r.backup_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    status: r.status,
    scope: r.scope,
    schemaName: r.schema_name,
    entityNames: r.entity_names ?? null,
    format: r.format,
    backupArtifactId: r.backup_artifact_id ?? null,
    reportArtifactId: r.report_artifact_id ?? null,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createBackup(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  status: string;
  schemaName: string;
  entityNames: string[] | null;
  format: string;
  policySnapshotRef?: string | null;
  runId?: string | null;
  stepId?: string | null;
  createdBySubjectId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO backups (tenant_id, space_id, status, schema_name, entity_names, format, policy_snapshot_ref, run_id, step_id, created_by_subject_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.status,
      params.schemaName,
      params.entityNames ? JSON.stringify(params.entityNames) : null,
      params.format,
      params.policySnapshotRef ?? null,
      params.runId ?? null,
      params.stepId ?? null,
      params.createdBySubjectId ?? null,
    ],
  );
  return toBackup(res.rows[0]);
}

export async function listBackups(params: { pool: Pool; tenantId: string; spaceId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM backups
      WHERE tenant_id = $1 AND space_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.spaceId, params.limit],
  );
  return res.rows.map(toBackup);
}

export async function getBackup(params: { pool: Pool; tenantId: string; backupId: string }) {
  const res = await params.pool.query("SELECT * FROM backups WHERE tenant_id = $1 AND backup_id = $2 LIMIT 1", [params.tenantId, params.backupId]);
  if (!res.rowCount) return null;
  return toBackup(res.rows[0]);
}

export async function updateBackupResult(params: {
  pool: Pool;
  tenantId: string;
  backupId: string;
  status: string;
  backupArtifactId?: string | null;
  reportArtifactId?: string | null;
}) {
  const res = await params.pool.query(
    `
      UPDATE backups
      SET status = $3,
          backup_artifact_id = COALESCE($4, backup_artifact_id),
          report_artifact_id = COALESCE($5, report_artifact_id),
          updated_at = now()
      WHERE tenant_id = $1 AND backup_id = $2
      RETURNING *
    `,
    [params.tenantId, params.backupId, params.status, params.backupArtifactId ?? null, params.reportArtifactId ?? null],
  );
  if (!res.rowCount) return null;
  return toBackup(res.rows[0]);
}
