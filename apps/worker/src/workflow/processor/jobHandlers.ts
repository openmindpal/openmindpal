import type { Pool } from "pg";
import { writeAudit } from "./audit";
import { executeEntityExport, executeEntityImport, executeSpaceBackup, executeSpaceRestore } from "./entity";
import { executeSchemaMigration } from "./schemaMigration";

export async function handleEntityExportJob(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  traceId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  inputDigest: any;
  input: any;
}) {
  const out = await executeEntityExport({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    traceId: params.traceId,
    input: params.input,
  });

  const outputDigest = { artifactId: out.artifactId, byteSize: out.byteSize, count: out.count, truncated: out.truncated };
  await params.pool.query(
    "UPDATE steps SET status = 'succeeded', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
    [params.stepId, out, outputDigest],
  );
  await params.pool.query("UPDATE runs SET status = 'succeeded', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
  await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [
    params.jobId,
    outputDigest,
  ]);
  await writeAudit(params.pool, {
    traceId: params.traceId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    resourceType: "entity",
    action: "export",
    result: "success",
    inputDigest: params.inputDigest,
    outputDigest,
  });
}

export async function handleEntityImportJob(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  traceId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  idempotencyKey: string;
  inputDigest: any;
  input: any;
}) {
  const out = await executeEntityImport({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    traceId: params.traceId,
    idempotencyKey: params.idempotencyKey,
    input: params.input,
  });

  const outputDigest = { artifactId: out.artifactId, byteSize: out.byteSize, acceptedCount: out.acceptedCount, rejectedCount: out.rejectedCount };
  await params.pool.query(
    "UPDATE steps SET status = 'succeeded', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
    [params.stepId, out, outputDigest],
  );
  await params.pool.query("UPDATE runs SET status = 'succeeded', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
  await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [
    params.jobId,
    outputDigest,
  ]);
  await writeAudit(params.pool, {
    traceId: params.traceId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    resourceType: "entity",
    action: "import",
    result: "success",
    inputDigest: params.inputDigest,
    outputDigest,
  });
}

export async function handleSpaceBackupJob(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  traceId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  inputDigest: any;
  input: any;
}) {
  const out = await executeSpaceBackup({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    traceId: params.traceId,
    input: params.input,
  });

  const outputDigest = { artifactId: out.artifactId, byteSize: out.byteSize, count: out.count, truncated: out.truncated };
  await params.pool.query(
    "UPDATE steps SET status = 'succeeded', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
    [params.stepId, out, outputDigest],
  );
  await params.pool.query("UPDATE runs SET status = 'succeeded', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
  await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [
    params.jobId,
    outputDigest,
  ]);
  await writeAudit(params.pool, {
    traceId: params.traceId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    resourceType: "backup",
    action: "backup",
    result: "success",
    inputDigest: params.inputDigest,
    outputDigest,
  });
}

export async function handleSpaceRestoreJob(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  traceId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  inputDigest: any;
  input: any;
}) {
  const out = await executeSpaceRestore({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    traceId: params.traceId,
    input: params.input,
  });

  const outputDigest = { artifactId: out.artifactId, byteSize: out.byteSize, acceptedCount: out.acceptedCount, rejectedCount: out.rejectedCount, conflicts: out.conflicts };
  await params.pool.query(
    "UPDATE steps SET status = 'succeeded', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
    [params.stepId, out, outputDigest],
  );
  await params.pool.query("UPDATE runs SET status = 'succeeded', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
  await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [
    params.jobId,
    outputDigest,
  ]);
  await writeAudit(params.pool, {
    traceId: params.traceId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    resourceType: "backup",
    action: "restore",
    result: "success",
    inputDigest: params.inputDigest,
    outputDigest,
  });
}

export async function handleSchemaMigrationJob(params: {
  pool: Pool;
  jobId: string;
  runId: string;
  stepId: string;
  traceId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  inputDigest: any;
  input: any;
}) {
  const migrationId = String(params.input?.migrationId ?? "");
  if (!migrationId) throw new Error("policy_violation:migration_not_found");

  let out: any;
  try {
    out = await executeSchemaMigration({ pool: params.pool, tenantId: params.tenantId, migrationId, stepId: params.stepId });
  } catch (e: any) {
    const raw = String(e?.message ?? "unknown");
    let msg = raw.slice(0, 1000);
    let category = "internal";
    if (raw === "migration_kind_not_supported") {
      category = "policy_violation";
      try {
        const kRes = await params.pool.query("SELECT kind FROM schema_migrations WHERE tenant_id = $1 AND migration_id = $2 LIMIT 1", [params.tenantId, migrationId]);
        const kind = kRes.rowCount ? String(kRes.rows[0].kind ?? "") : "";
        msg = `MIGRATION_KIND_NOT_SUPPORTED:${kind || "unknown"}`;
      } catch {
        msg = "MIGRATION_KIND_NOT_SUPPORTED:unknown";
      }
    }
    await params.pool.query(
      `
        UPDATE schema_migration_runs
        SET status = 'failed', last_error = $3, finished_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND step_id = $2
      `,
      [params.tenantId, params.stepId, msg],
    );
    await params.pool.query("UPDATE schema_migrations SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND migration_id = $2", [params.tenantId, migrationId]);
    const outputDigest = { migrationId, processedCount: 0, canceled: false, error: msg };
    await params.pool.query(
      "UPDATE steps SET status = 'failed', error_category = $2, last_error = $3, output_digest = $4, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
      [params.stepId, category, msg, outputDigest],
    );
    await params.pool.query("UPDATE runs SET status = 'failed', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
    await params.pool.query("UPDATE jobs SET status = 'failed', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, outputDigest]);
    await writeAudit(params.pool, {
      traceId: params.traceId,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      runId: params.runId,
      stepId: params.stepId,
      resourceType: "schema",
      action: "migration",
      result: "error",
      inputDigest: params.inputDigest,
      outputDigest,
      errorCategory: category,
    });
    return;
  }
  const outputDigest = { migrationId, processedCount: out.processedCount, canceled: out.canceled };

  if (out.canceled) {
    await params.pool.query(
      "UPDATE steps SET status = 'canceled', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
      [params.stepId, out, outputDigest],
    );
    await params.pool.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
    await params.pool.query("UPDATE jobs SET status = 'canceled', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, outputDigest]);
    await writeAudit(params.pool, { traceId: params.traceId, tenantId: params.tenantId, spaceId: params.spaceId, subjectId: params.subjectId, runId: params.runId, stepId: params.stepId, resourceType: "schema", action: "migration", result: "error", inputDigest: params.inputDigest, outputDigest });
    return;
  }

  await params.pool.query(
    "UPDATE steps SET status = 'succeeded', output = $2, output_digest = $3, updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE step_id = $1",
    [params.stepId, out, outputDigest],
  );
  await params.pool.query("UPDATE runs SET status = 'succeeded', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1", [params.runId]);
  await params.pool.query("UPDATE jobs SET status = 'succeeded', progress = 100, updated_at = now(), result_summary = $2 WHERE job_id = $1", [params.jobId, outputDigest]);
  await writeAudit(params.pool, {
    traceId: params.traceId,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    runId: params.runId,
    stepId: params.stepId,
    resourceType: "schema",
    action: "migration",
    result: "success",
    inputDigest: params.inputDigest,
    outputDigest,
  });
}
