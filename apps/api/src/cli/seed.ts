import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";
import { autoDiscoverAndRegisterTools } from "../modules/tools/toolAutoDiscovery";

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "../../migrations"),
    path.resolve(process.cwd(), "apps/api/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) return c;
    } catch {
      continue;
    }
  }
  return candidates[1];
}

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);

  await migrate(pool, await findMigrationsDir());

  const tenantId = process.env.SEED_TENANT_ID ?? "tenant_dev";
  const spaceId = process.env.SEED_SPACE_ID ?? "space_dev";
  const adminSubjectId = process.env.SEED_ADMIN_SUBJECT_ID ?? "admin";

  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [tenantId]);
  await pool.query(
    "INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [spaceId, tenantId],
  );
  await pool.query(
    "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [adminSubjectId, tenantId],
  );

  const adminRoleId = "role_admin";
  await pool.query(
    "INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    [adminRoleId, tenantId, "Admin"],
  );

  const permRes = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["*", "*"],
  );
  const permId = permRes.rows[0].id as string;

  await pool.query(
    "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [adminRoleId, permId],
  );

  const govRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "policy_snapshot.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govRead.rows[0].id as string,
  ]);
  const govExplain = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "policy_snapshot.explain"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govExplain.rows[0].id as string,
  ]);

  const govPolicyRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "policy.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govPolicyRead.rows[0].id as string,
  ]);
  const govPolicyWrite = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "policy.write"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govPolicyWrite.rows[0].id as string,
  ]);
  const govPolicyRelease = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "policy.release"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govPolicyRelease.rows[0].id as string,
  ]);

  const govModelUsageRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "model_usage.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govModelUsageRead.rows[0].id as string,
  ]);

  const govDiagnosticsRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "diagnostics.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govDiagnosticsRead.rows[0].id as string,
  ]);

  const govNetRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "tool.network_policy.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govNetRead.rows[0].id as string,
  ]);
  const govNetWrite = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "tool.network_policy.write"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    govNetWrite.rows[0].id as string,
  ]);

  const artifactPolicyRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "artifact.policy.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    artifactPolicyRead.rows[0].id as string,
  ]);
  const artifactPolicyWrite = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["governance", "artifact.policy.write"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    artifactPolicyWrite.rows[0].id as string,
  ]);

  const siemRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.destination.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemRead.rows[0].id as string,
  ]);
  const siemWrite = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.destination.write"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemWrite.rows[0].id as string,
  ]);
  const siemTest = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.destination.test"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemTest.rows[0].id as string,
  ]);
  const siemBackfill = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.destination.backfill"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemBackfill.rows[0].id as string,
  ]);

  const siemDlqRead = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.dlq.read"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemDlqRead.rows[0].id as string,
  ]);
  const siemDlqWrite = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "siem.dlq.write"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    siemDlqWrite.rows[0].id as string,
  ]);

  const auditVerify = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["audit", "verify"],
  );
  await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    adminRoleId,
    auditVerify.rows[0].id as string,
  ]);

  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    [adminSubjectId, adminRoleId, tenantId],
  );

  // 为默认的 Web 用户添加管理员权限（开发环境）
  const devWebSubjectId = process.env.SEED_WEB_SUBJECT_ID ?? "anonymous";
  if (devWebSubjectId !== adminSubjectId) {
    await pool.query(
      "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [devWebSubjectId, tenantId],
    );
    await pool.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
      [devWebSubjectId, adminRoleId, tenantId],
    );
    console.log(`[seed] granted admin role to dev web user: ${devWebSubjectId}`);
  }

  const mockModelRef = process.env.SEED_DEFAULT_MODEL_REF ?? "mock:echo-1";
  const egressPolicy = { allowedDomains: ["mock.local"] };
  const instRes = await pool.query(
    `
      INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
      VALUES ($1, 'space', $2, 'model-mock', 'generic.api_key', 'enabled', $3::jsonb)
      ON CONFLICT (tenant_id, scope_type, scope_id, name)
      DO UPDATE SET status = 'enabled', egress_policy = EXCLUDED.egress_policy, updated_at = now()
      RETURNING id
    `,
    [tenantId, spaceId, JSON.stringify(egressPolicy)],
  );
  const connectorInstanceId = String(instRes.rows[0].id);
  const secretExisting = await pool.query(
    "SELECT id FROM secret_records WHERE tenant_id = $1 AND connector_instance_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [tenantId, connectorInstanceId],
  );
  const secretId =
    secretExisting.rowCount
      ? String(secretExisting.rows[0].id)
      : String(
          (
            await pool.query(
              `
                INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, encrypted_payload)
                VALUES ($1, 'space', $2, $3, 'active', '{}'::jsonb)
                RETURNING id
              `,
              [tenantId, spaceId, connectorInstanceId],
            )
          ).rows[0].id,
        );
  await pool.query(
    `
      INSERT INTO provider_bindings (tenant_id, scope_type, scope_id, model_ref, provider, model, base_url, connector_instance_id, secret_id, secret_ids, status)
      VALUES ($1, 'space', $2, $3, 'mock', 'echo-1', NULL, $4, $5, jsonb_build_array($6::text), 'enabled')
      ON CONFLICT (tenant_id, scope_type, scope_id, model_ref)
      DO UPDATE SET connector_instance_id = EXCLUDED.connector_instance_id, secret_id = EXCLUDED.secret_id, secret_ids = EXCLUDED.secret_ids, status = 'enabled', updated_at = now()
    `,
    [tenantId, spaceId, mockModelRef, connectorInstanceId, secretId, secretId],
  );
  await pool.query(
    `
      INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1, 'orchestrator.turn', $2, '[]'::jsonb, true)
      ON CONFLICT (tenant_id, purpose)
      DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = true, updated_at = now()
    `,
    [tenantId, mockModelRef],
  );

  const schemaExists = await pool.query(
    "SELECT 1 FROM schemas WHERE name = 'core' AND status = 'released' LIMIT 1",
  );
  if (!schemaExists.rowCount) {
    const seedCandidates = [
      path.resolve(process.cwd(), "apps/api/seed/core.schema.json"),
      path.resolve(process.cwd(), "seed/core.schema.json"),
    ];
    let seedPath: string | null = null;
    for (const p of seedCandidates) {
      try {
        const stat = await fs.stat(p);
        if (stat.isFile()) {
          seedPath = p;
          break;
        }
      } catch {
        continue;
      }
    }
    if (seedPath) {
      const raw = await fs.readFile(seedPath, "utf8");
      const schema = JSON.parse(raw);
      const latest = await pool.query(
        "SELECT version FROM schemas WHERE name = 'core' AND status = 'released' ORDER BY version DESC LIMIT 1",
      );
      const nextVersion = (latest.rowCount ? (latest.rows[0].version as number) : 0) + 1;
      schema.version = nextVersion;
      await pool.query(
        "INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ('core', $1, 'released', $2, now())",
        [nextVersion, schema],
      );
    }
  }

  const uiExists = await pool.query(
    "SELECT 1 FROM page_template_versions WHERE tenant_id = $1 AND status = 'released' LIMIT 1",
    [tenantId],
  );
  if (!uiExists.rowCount) {
    await pool.query(
      `
        INSERT INTO page_templates (tenant_id, scope_type, scope_id, name)
        VALUES
          ($1, 'tenant', $1, 'notes.list'),
          ($1, 'tenant', $1, 'notes.new')
        ON CONFLICT (tenant_id, scope_type, scope_id, name) DO UPDATE SET updated_at = now()
      `,
      [tenantId],
    );
    await pool.query(
      `
        INSERT INTO page_template_versions (
          tenant_id, scope_type, scope_id, name, version, status, page_type, title, params, data_bindings, action_bindings
        )
        VALUES
          ($1, 'tenant', $1, 'notes.list', 1, 'released', 'entity.list', $2, $3, $4, $5),
          ($1, 'tenant', $1, 'notes.new', 1, 'released', 'entity.new', $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
      `,
      [
        tenantId,
        JSON.stringify({ "zh-CN": "笔记", "en-US": "Notes" }),
        JSON.stringify({ entityName: "notes" }),
        JSON.stringify([{ target: "entities.list", entityName: "notes" }]),
        JSON.stringify([{ action: "create", toolRef: "entity.create@1" }]),
        JSON.stringify({ "zh-CN": "新建笔记", "en-US": "New note" }),
        JSON.stringify({ entityName: "notes" }),
        JSON.stringify([{ target: "schema.effective", entityName: "notes", schemaName: "core" }]),
        JSON.stringify([{ action: "create", toolRef: "entity.create@1" }]),
      ],
    );
  }

  // Auto-discover and register all tools (built-in + skill manifests)
  try {
    const discovery = await autoDiscoverAndRegisterTools(pool);
    console.log(`[tool-discovery] registered=${discovery.registered} skipped=${discovery.skipped}`);
  } catch (err) {
    console.error("[tool-discovery] failed:", err);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
