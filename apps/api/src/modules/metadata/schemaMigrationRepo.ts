import type { Pool } from "pg";

export type SchemaMigrationRow = {
  migrationId: string;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  schemaName: string;
  targetVersion: number;
  kind: string;
  plan: any;
  status: string;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SchemaMigrationRunRow = {
  migrationRunId: string;
  tenantId: string;
  migrationId: string;
  status: string;
  progress: any;
  jobId: string | null;
  runId: string | null;
  stepId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toMigration(r: any): SchemaMigrationRow {
  return {
    migrationId: r.migration_id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    schemaName: r.schema_name,
    targetVersion: Number(r.target_version),
    kind: r.kind,
    plan: r.plan_json,
    status: r.status,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: any): SchemaMigrationRunRow {
  return {
    migrationRunId: r.migration_run_id,
    tenantId: r.tenant_id,
    migrationId: r.migration_id,
    status: r.status,
    progress: r.progress_json ?? null,
    jobId: r.job_id ?? null,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    lastError: r.last_error ?? null,
    canceledAt: r.canceled_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createSchemaMigration(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  schemaName: string;
  targetVersion: number;
  kind: string;
  plan: any;
  createdBySubjectId: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO schema_migrations (tenant_id, scope_type, scope_id, schema_name, target_version, kind, plan_json, status, created_by_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'created',$8)
      RETURNING *
    `,
    [params.tenantId, params.scopeType, params.scopeId, params.schemaName, params.targetVersion, params.kind, params.plan, params.createdBySubjectId],
  );
  return toMigration(res.rows[0]);
}

export async function setSchemaMigrationStatus(params: { pool: Pool; tenantId: string; migrationId: string; status: string }) {
  const res = await params.pool.query(
    `
      UPDATE schema_migrations
      SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND migration_id = $2
      RETURNING *
    `,
    [params.tenantId, params.migrationId, params.status],
  );
  if (!res.rowCount) return null;
  return toMigration(res.rows[0]);
}

export async function getSchemaMigration(params: { pool: Pool; tenantId: string; migrationId: string }) {
  const res = await params.pool.query("SELECT * FROM schema_migrations WHERE tenant_id = $1 AND migration_id = $2 LIMIT 1", [params.tenantId, params.migrationId]);
  if (!res.rowCount) return null;
  return toMigration(res.rows[0]);
}

export async function listSchemaMigrations(params: { pool: Pool; tenantId: string; schemaName?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.schemaName) {
    where.push(`schema_name = $${idx++}`);
    args.push(params.schemaName);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM schema_migrations
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    [...args, params.limit],
  );
  return res.rows.map(toMigration);
}

export async function createSchemaMigrationRun(params: {
  pool: Pool;
  tenantId: string;
  migrationId: string;
  jobId: string | null;
  runId: string | null;
  stepId: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO schema_migration_runs (tenant_id, migration_id, status, job_id, run_id, step_id)
      VALUES ($1,$2,'queued',$3,$4,$5)
      RETURNING *
    `,
    [params.tenantId, params.migrationId, params.jobId, params.runId, params.stepId],
  );
  return toRun(res.rows[0]);
}

export async function getSchemaMigrationRun(params: { pool: Pool; tenantId: string; migrationRunId: string }) {
  const res = await params.pool.query("SELECT * FROM schema_migration_runs WHERE tenant_id = $1 AND migration_run_id = $2 LIMIT 1", [params.tenantId, params.migrationRunId]);
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

export async function setSchemaMigrationRunCanceled(params: { pool: Pool; tenantId: string; migrationRunId: string }) {
  const res = await params.pool.query(
    `
      UPDATE schema_migration_runs
      SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND migration_run_id = $2
      RETURNING *
    `,
    [params.tenantId, params.migrationRunId],
  );
  if (!res.rowCount) return null;
  return toRun(res.rows[0]);
}

