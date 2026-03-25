import type { Pool } from "pg";
import { isSupportedSchemaMigrationKind } from "@openslin/shared";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function parsePath(path: unknown) {
  const raw = String(path ?? "").trim();
  if (!raw) return null;
  const segs = raw.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || segs.length > 10) return null;
  const ok = segs.every((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length <= 100);
  if (!ok) return null;
  return segs;
}

export async function executeSchemaMigration(params: { pool: Pool; tenantId: string; migrationId: string; stepId: string }) {
  const migRes = await params.pool.query("SELECT * FROM schema_migrations WHERE tenant_id = $1 AND migration_id = $2 LIMIT 1", [params.tenantId, params.migrationId]);
  if (!migRes.rowCount) throw new Error("policy_violation:migration_not_found");
  const mig = migRes.rows[0] as any;

  const runRes = await params.pool.query(
    "SELECT * FROM schema_migration_runs WHERE tenant_id = $1 AND migration_id = $2 AND step_id = $3 ORDER BY created_at DESC LIMIT 1",
    [params.tenantId, params.migrationId, params.stepId],
  );
  if (!runRes.rowCount) throw new Error("policy_violation:migration_run_not_found");
  const run = runRes.rows[0] as any;

  const status = String(run.status ?? "");
  if (status === "canceled") return { processedCount: 0, canceled: true };
  if (String(mig.status ?? "") === "canceled") return { processedCount: 0, canceled: true };

  await params.pool.query(
    `
      UPDATE schema_migration_runs
      SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE tenant_id = $1 AND migration_run_id = $2 AND status = 'queued'
    `,
    [params.tenantId, run.migration_run_id],
  );
  await params.pool.query("UPDATE schema_migrations SET status = 'running', updated_at = now() WHERE tenant_id = $1 AND migration_id = $2 AND status IN ('created','queued')", [
    params.tenantId,
    params.migrationId,
  ]);

  const kind = String(mig.kind ?? "");
  const plan = mig.plan_json ?? null;
  if (!isPlainObject(plan)) throw new Error("migration_plan_invalid");

  const scopeType = String(mig.scope_type ?? "");
  const scopeId = String(mig.scope_id ?? "");
  const schemaName = String(mig.schema_name ?? "");
  const targetVersion = Number(mig.target_version ?? 0);
  if (!schemaName || !Number.isFinite(targetVersion) || targetVersion <= 0) throw new Error("migration_plan_invalid");

  let processed = 0;
  const batchSize = Math.max(1, Math.min(500, Number((plan as any).batchSize ?? 200) || 200));

  if (!isSupportedSchemaMigrationKind(kind)) {
    throw new Error("migration_kind_not_supported");
  }

  if (kind === "backfill_required_field") {
    const entityName = String((plan as any).entityName ?? "");
    const fieldPath = parsePath((plan as any).fieldPath);
    const defaultValue = (plan as any).defaultValue;
    if (!entityName || !fieldPath) throw new Error("migration_plan_invalid");
    const valueJson = JSON.stringify(defaultValue ?? null);

    while (true) {
      const canceledNow = await params.pool.query(
        "SELECT status FROM schema_migration_runs WHERE tenant_id = $1 AND migration_run_id = $2 LIMIT 1",
        [params.tenantId, run.migration_run_id],
      );
      const st = canceledNow.rowCount ? String(canceledNow.rows[0].status ?? "") : "";
      if (st === "canceled") return { processedCount: processed, canceled: true };

      const args: any[] = [params.tenantId, schemaName, entityName];
      let idx = 3;
      const where: string[] = ["tenant_id = $1", "schema_name = $2", "entity_name = $3"];
      if (scopeType === "space") {
        args.push(scopeId);
        where.push(`space_id = $${++idx}`);
      }
      args.push(fieldPath);
      where.push(`(payload #> $${++idx}::text[]) IS NULL`);
      args.push(batchSize);
      const sel = await params.pool.query(
        `
          SELECT id
          FROM entity_records
          WHERE ${where.join(" AND ")}
          ORDER BY id ASC
          LIMIT $${++idx}
        `,
        args,
      );
      if (!sel.rowCount) break;
      const ids = sel.rows.map((r: any) => String(r.id));

      const upd = await params.pool.query(
        `
          UPDATE entity_records
          SET payload = jsonb_set(payload, $3::text[], $4::jsonb, true),
              schema_version = GREATEST(schema_version, $5::int),
              updated_at = now()
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        `,
        [params.tenantId, ids, fieldPath, valueJson, targetVersion],
      );

      processed += Number(upd.rowCount ?? 0);
      await params.pool.query(
        `
          UPDATE schema_migration_runs
          SET progress_json = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND migration_run_id = $2
        `,
        [params.tenantId, run.migration_run_id, { kind, processedCount: processed, lastBatchSize: ids.length, schemaName, entityName, fieldPath: fieldPath.join("."), targetVersion }],
      );
      if (ids.length < batchSize) break;
    }

    await params.pool.query(
      `
        UPDATE schema_migration_runs
        SET status = 'succeeded', finished_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND migration_run_id = $2 AND status <> 'canceled'
      `,
      [params.tenantId, run.migration_run_id],
    );
    await params.pool.query("UPDATE schema_migrations SET status = 'completed', updated_at = now() WHERE tenant_id = $1 AND migration_id = $2 AND status <> 'canceled'", [
      params.tenantId,
      params.migrationId,
    ]);

    return { processedCount: processed, canceled: false };
  }

  if (kind === "rename_field_dual_write") {
    const entityName = String((plan as any).entityName ?? "");
    const fromPath = parsePath((plan as any).fromPath);
    const toPath = parsePath((plan as any).toPath);
    if (!entityName || !fromPath || !toPath) throw new Error("migration_plan_invalid");

    while (true) {
      const canceledNow = await params.pool.query(
        "SELECT status FROM schema_migration_runs WHERE tenant_id = $1 AND migration_run_id = $2 LIMIT 1",
        [params.tenantId, run.migration_run_id],
      );
      const st = canceledNow.rowCount ? String(canceledNow.rows[0].status ?? "") : "";
      if (st === "canceled") return { processedCount: processed, canceled: true };

      const args: any[] = [params.tenantId, schemaName, entityName];
      let idx = 3;
      const where: string[] = ["tenant_id = $1", "schema_name = $2", "entity_name = $3"];
      if (scopeType === "space") {
        args.push(scopeId);
        where.push(`space_id = $${++idx}`);
      }
      args.push(toPath);
      where.push(`(payload #> $${++idx}::text[]) IS NULL`);
      args.push(fromPath);
      where.push(`(payload #> $${++idx}::text[]) IS NOT NULL`);
      args.push(batchSize);
      const sel = await params.pool.query(
        `
          SELECT id
          FROM entity_records
          WHERE ${where.join(" AND ")}
          ORDER BY id ASC
          LIMIT $${++idx}
        `,
        args,
      );
      if (!sel.rowCount) break;
      const ids = sel.rows.map((r: any) => String(r.id));

      const upd = await params.pool.query(
        `
          UPDATE entity_records
          SET payload = jsonb_set(payload, $3::text[], payload #> $4::text[], true),
              schema_version = GREATEST(schema_version, $5::int),
              updated_at = now()
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        `,
        [params.tenantId, ids, toPath, fromPath, targetVersion],
      );

      processed += Number(upd.rowCount ?? 0);
      await params.pool.query(
        `
          UPDATE schema_migration_runs
          SET progress_json = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1 AND migration_run_id = $2
        `,
        [params.tenantId, run.migration_run_id, { kind, processedCount: processed, lastBatchSize: ids.length, schemaName, entityName, fromPath: fromPath.join("."), toPath: toPath.join("."), targetVersion }],
      );
      if (ids.length < batchSize) break;
    }

    await params.pool.query(
      `
        UPDATE schema_migration_runs
        SET status = 'succeeded', finished_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND migration_run_id = $2 AND status <> 'canceled'
      `,
      [params.tenantId, run.migration_run_id],
    );
    await params.pool.query("UPDATE schema_migrations SET status = 'completed', updated_at = now() WHERE tenant_id = $1 AND migration_id = $2 AND status <> 'canceled'", [
      params.tenantId,
      params.migrationId,
    ]);

    return { processedCount: processed, canceled: false };
  }

  throw new Error("migration_kind_not_supported");
}
