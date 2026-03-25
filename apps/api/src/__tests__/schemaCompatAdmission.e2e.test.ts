import crypto from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";
import { buildServer } from "../server";
import { processStep } from "../../../worker/src/workflow/processor";

const cfg = loadConfig(process.env);
const pool = createPool(cfg);
const cwd = process.cwd();
const isApiCwd = cwd.replaceAll("\\", "/").endsWith("/apps/api");
const migrationsDir = isApiCwd ? path.resolve(cwd, "migrations") : path.resolve(cwd, "apps/api/migrations");

async function seedMinimal() {
  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["tenant_dev"]);
  await pool.query("INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["space_dev", "tenant_dev"]);
  await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["admin", "tenant_dev"]);
  await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["approver", "tenant_dev"]);
  await pool.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", ["role_admin", "tenant_dev", "Admin"]);
  const permRes = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["*", "*"],
  );
  const permId = permRes.rows[0].id as string;
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", ["role_admin", permId]);
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    ["admin", "role_admin", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    ["approver", "role_admin", "tenant_dev"],
  );
}

describe.sequential("schema compat admission e2e", { timeout: 60_000 }, () => {
  const app: any = buildServer(cfg, { db: pool, queue: { add: async () => ({}) } as any });
  let canRun = false;

  const headers = {
    authorization: "Bearer admin",
    "x-tenant-id": "tenant_dev",
    "x-space-id": "space_dev",
    "content-type": "application/json",
  };
  const actionHeaders = {
    authorization: "Bearer admin",
    "x-tenant-id": "tenant_dev",
    "x-space-id": "space_dev",
  };

  beforeAll(async () => {
    try {
      await migrate(pool, migrationsDir);
      await seedMinimal();
      await app.ready();
      canRun = true;
    } catch (e) {
      app.log.error(e);
      canRun = false;
    }
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 120_000);

  it("migration_required：preflight 生成 migrationDrafts，release 无 migrationRunId 被阻断", async () => {
    if (!canRun) return;
    const schemaName = `t_schema_mig_${crypto.randomUUID().slice(0, 8)}`;
    const entityName = "titems";

    const v1 = {
      name: schemaName,
      version: 1,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
          },
        },
      },
    };
    await pool.query("INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, 1, 'released', $2, now())", [schemaName, v1]);

    const v2 = {
      name: schemaName,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
            b: { type: "string", required: true },
          },
        },
      },
    };

    const cs = await app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema publish gate ${schemaName}`, scope: "tenant" }),
    });
    expect(cs.statusCode).toBe(200);
    const csId = String((cs.json() as any).changeset.id);

    const addItem = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/items`,
      headers: { ...headers, "x-trace-id": `t-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.publish", name: schemaName, schemaDef: v2 }),
    });
    expect(addItem.statusCode).toBe(200);

    const preflight = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/preflight`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-preflight-${crypto.randomUUID()}` },
    });
    expect(preflight.statusCode).toBe(200);
    const pf = preflight.json() as any;
    const p = (pf.plan as any[]).find((x) => x.kind === "schema.publish" && x.schemaName === schemaName);
    expect(p).toBeTruthy();
    expect(p.compatReport?.level).toBe("migration_required");
    expect(p.admission?.decision).toBe("block_release");
    expect(Array.isArray(p.migrationDrafts)).toBe(true);
    expect(p.migrationDrafts.length).toBeGreaterThan(0);
    expect(p.migrationDrafts[0]?.rollbackPlanSummary?.stopPlan?.cancelRun?.path).toContain("/governance/schema-migration-runs");

    const submit = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-submit-${crypto.randomUUID()}` },
    });
    expect(submit.statusCode).toBe(200);
    const approve1 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-approve-${crypto.randomUUID()}` },
    });
    expect(approve1.statusCode).toBe(200);
    const approve2 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(approve2.statusCode).toBe(200);

    const rel = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-release-${crypto.randomUUID()}` },
    });
    expect(rel.statusCode).toBe(403);
    expect((rel.json() as any).errorCode).toBe("SCHEMA_MIGRATION_REQUIRED");
  });

  it("migration_required：迁移成功后允许发布并切换 active", async () => {
    if (!canRun) return;
    const schemaName = `t_schema_mig2_${crypto.randomUUID().slice(0, 8)}`;
    const entityName = "titems";

    const v1 = {
      name: schemaName,
      version: 1,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
          },
        },
      },
    };
    await pool.query("INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, 1, 'released', $2, now())", [schemaName, v1]);

    const v2 = {
      name: schemaName,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
            b: { type: "string", required: true },
          },
        },
      },
    };

    const cs0 = await app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-cs-create0-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema publish preflight ${schemaName}`, scope: "tenant" }),
    });
    expect(cs0.statusCode).toBe(200);
    const cs0Id = String((cs0.json() as any).changeset.id);
    const add0 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(cs0Id)}/items`,
      headers: { ...headers, "x-trace-id": `t-cs-item0-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.publish", name: schemaName, schemaDef: v2 }),
    });
    expect(add0.statusCode).toBe(200);
    const pf0 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(cs0Id)}/preflight`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-preflight0-${crypto.randomUUID()}` },
    });
    expect(pf0.statusCode).toBe(200);
    const plan0 = (pf0.json() as any).plan as any[];
    const entry0 = plan0.find((x) => x.kind === "schema.publish" && x.schemaName === schemaName);
    expect(entry0?.nextVersionHint).toBe(2);
    const draft0 = (entry0?.migrationDrafts as any[]).find((d) => d.kind === "backfill_required_field");
    expect(draft0).toBeTruthy();

    const createMig = await app.inject({
      method: "POST",
      url: "/governance/schema-migrations",
      headers: { ...headers, "x-trace-id": `t-mig-create-${crypto.randomUUID()}` },
      payload: JSON.stringify(draft0.createRequest.body),
    });
    expect(createMig.statusCode).toBe(200);
    const migBody = createMig.json() as any;
    const jobId = String(migBody.migrationRun.jobId);
    const runId = String(migBody.migrationRun.runId);
    const stepId = String(migBody.migrationRun.stepId);
    const migrationRunId = String(migBody.migrationRun.migrationRunId);

    await processStep({ pool, jobId, runId, stepId });

    const cs = await app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema publish ${schemaName}`, scope: "tenant" }),
    });
    expect(cs.statusCode).toBe(200);
    const csId = String((cs.json() as any).changeset.id);

    const addItem = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/items`,
      headers: { ...headers, "x-trace-id": `t-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.publish", name: schemaName, schemaDef: v2, migrationRunId }),
    });
    expect(addItem.statusCode).toBe(200);

    const submit = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-submit-${crypto.randomUUID()}` },
    });
    expect(submit.statusCode).toBe(200);
    const approve1 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-approve-${crypto.randomUUID()}` },
    });
    expect(approve1.statusCode).toBe(200);
    const approve2 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(approve2.statusCode).toBe(200);

    const rel = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-release-${crypto.randomUUID()}` },
    });
    expect(rel.statusCode).toBe(200);

    const latest = await app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(schemaName)}/latest`,
      headers: { ...headers, "x-trace-id": `t-latest-${crypto.randomUUID()}` },
    });
    expect(latest.statusCode).toBe(200);
    expect((latest.json() as any).version).toBe(2);

    const runRes = await app.inject({
      method: "GET",
      url: `/governance/schema-migration-runs/${encodeURIComponent(migrationRunId)}`,
      headers: { ...actionHeaders, "x-trace-id": `t-mig-run-${crypto.randomUUID()}` },
    });
    expect(runRes.statusCode).toBe(200);
    expect((runRes.json() as any).run.status).toBe("succeeded");
  });

  it("breaking：类型变更默认拒绝发布", async () => {
    if (!canRun) return;
    const schemaName = `t_schema_break_${crypto.randomUUID().slice(0, 8)}`;
    const entityName = "titems";

    const v1 = {
      name: schemaName,
      version: 1,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
          },
        },
      },
    };
    await pool.query("INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, 1, 'released', $2, now())", [schemaName, v1]);

    const v2 = {
      name: schemaName,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "number", required: true },
          },
        },
      },
    };

    const cs = await app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema publish breaking ${schemaName}`, scope: "tenant" }),
    });
    expect(cs.statusCode).toBe(200);
    const csId = String((cs.json() as any).changeset.id);

    const addItem = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/items`,
      headers: { ...headers, "x-trace-id": `t-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.publish", name: schemaName, schemaDef: v2 }),
    });
    expect(addItem.statusCode).toBe(200);

    const submit = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-submit-${crypto.randomUUID()}` },
    });
    expect(submit.statusCode).toBe(200);
    const approve1 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-approve-${crypto.randomUUID()}` },
    });
    expect(approve1.statusCode).toBe(200);
    const approve2 = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(approve2.statusCode).toBe(200);

    const rel = await app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csId)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-cs-release-${crypto.randomUUID()}` },
    });
    expect(rel.statusCode).toBe(403);
    expect((rel.json() as any).errorCode).toBe("SCHEMA_BREAKING_CHANGE");
  });
});

