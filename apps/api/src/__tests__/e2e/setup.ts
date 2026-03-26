/**
 * E2E测试共享设置
 * 提供数据库连接、服务器启动、种子数据等公共功能
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import * as tar from "tar";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { loadConfig } from "../../config";
import { migrate } from "../../db/migrate";
import { createPool } from "../../db/pool";
import { buildServer } from "../../server";
import { redactString } from "@openslin/shared";
import { processAuditExport } from "../../../../worker/src/audit/exportProcessor";
import { processKnowledgeEmbeddingJob } from "../../../../worker/src/knowledge/embedding";
import { processKnowledgeIngestJob } from "../../../../worker/src/knowledge/ingest";
import { processKnowledgeIndexJob } from "../../../../worker/src/knowledge/processor";
import { processMediaJob } from "../../../../worker/src/media/processor";
import { processSubscriptionPoll } from "../../../../worker/src/subscriptions/processor";
import { reencryptSecrets } from "../../../../worker/src/keyring/reencrypt";
import { processStep } from "../../../../worker/src/workflow/processor";
import { writeAudit as writeWorkerAudit } from "../../../../worker/src/workflow/processor/audit";
import { decryptStepInputIfNeeded as decryptStepInputIfNeededWorker } from "../../../../worker/src/workflow/processor/encryption";
import { decryptSecretPayload, encryptSecretEnvelope } from "../../modules/secrets/envelope";
import { dispatchAuditOutboxBatch } from "../../modules/audit/outboxRepo";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// ─── 配置 ─────────────────────────────────────────────────────────────
export const cfg = loadConfig(process.env);
export const pool = createPool(cfg);

const cwd = process.cwd();
const isApiCwd = cwd.replaceAll("\\", "/").endsWith("/apps/api");
export const migrationsDir = isApiCwd ? path.resolve(cwd, "migrations") : path.resolve(cwd, "apps/api/migrations");
export const seedSchemaPath = isApiCwd ? path.resolve(cwd, "seed/core.schema.json") : path.resolve(cwd, "apps/api/seed/core.schema.json");
export const suiteStartedAtIso = new Date().toISOString();

// ─── 重新导出工具函数 ─────────────────────────────────────────────────
export {
  fs, path, crypto, http, os, tar,
  describe, expect, it, beforeAll, afterAll, vi,
  redactString,
  processAuditExport,
  processKnowledgeEmbeddingJob,
  processKnowledgeIngestJob,
  processKnowledgeIndexJob,
  processMediaJob,
  processSubscriptionPoll,
  reencryptSecrets,
  processStep,
  writeWorkerAudit,
  decryptStepInputIfNeededWorker,
  decryptSecretPayload,
  encryptSecretEnvelope,
  dispatchAuditOutboxBatch,
};

// ─── CapabilityEnvelope 构建器 ────────────────────────────────────────
export function capabilityEnvelopeV1(params: {
  tenantId?: string;
  spaceId?: string | null;
  subjectId?: string | null;
  scope: string;
  resourceType: string;
  action: string;
  limits?: any;
  networkPolicy?: any;
  fieldRules?: any;
  rowFilters?: any;
}) {
  const tenantId = params.tenantId ?? "tenant_dev";
  const spaceId = params.spaceId ?? "space_dev";
  const subjectId = params.subjectId ?? "admin";
  return {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId,
      spaceId,
      subjectId,
      toolContract: {
        scope: params.scope,
        resourceType: params.resourceType,
        action: params.action,
        fieldRules: params.fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } },
        rowFilters: params.rowFilters ?? null,
      },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: params.networkPolicy ?? { allowedDomains: [], rules: [] } },
    resourceDomain: { limits: params.limits ?? {} },
  };
}

// ─── 种子数据 ─────────────────────────────────────────────────────────
export async function seed() {
  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["tenant_dev"]);
  await pool.query(
    "INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["space_dev", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["space_other", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["admin", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["approver", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["noperm", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    ["role_admin", "tenant_dev", "Admin"],
  );
  const permRes = await pool.query(
    "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
    ["*", "*"],
  );
  const permId = permRes.rows[0].id as string;
  await pool.query(
    "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    ["role_admin", permId],
  );
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    ["admin", "role_admin", "tenant_dev"],
  );
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    ["approver", "role_admin", "tenant_dev"],
  );

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
    ["tenant_dev", "space_dev", JSON.stringify(egressPolicy)],
  );
  const connectorInstanceId = String(instRes.rows[0].id);
  const secretExisting = await pool.query(
    "SELECT id FROM secret_records WHERE tenant_id = $1 AND connector_instance_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ["tenant_dev", connectorInstanceId],
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
              ["tenant_dev", "space_dev", connectorInstanceId],
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
    ["tenant_dev", "space_dev", mockModelRef, connectorInstanceId, secretId, secretId],
  );
  await pool.query(
    `
      INSERT INTO routing_policies (tenant_id, purpose, primary_model_ref, fallback_model_refs, enabled)
      VALUES ($1, 'orchestrator.turn', $2, '[]'::jsonb, true)
      ON CONFLICT (tenant_id, purpose)
      DO UPDATE SET primary_model_ref = EXCLUDED.primary_model_ref, fallback_model_refs = EXCLUDED.fallback_model_refs, enabled = true, updated_at = now()
    `,
    ["tenant_dev", mockModelRef],
  );

  const ensurePerm = async (resourceType: string, action: string) => {
    const r = await pool.query(
      "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
      [resourceType, action],
    );
    return String(r.rows[0].id);
  };

  await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["user1", "tenant_dev"]);
  await pool.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", ["role_user", "tenant_dev", "User"]);
  await pool.query(
    "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
    ["user1", "role_user", "tenant_dev"],
  );

  const pAuthTokenSelf = await ensurePerm("auth", "token.self");
  const pSyncPush = await ensurePerm("sync", "push");
  const pEntityCreate = await ensurePerm("entity", "create");
  const pEntityUpdate = await ensurePerm("entity", "update");

  await pool.query(
    `
      INSERT INTO role_permissions (role_id, permission_id)
      VALUES ($1,$2),($1,$3),($1,$4),($1,$5)
      ON CONFLICT DO NOTHING
    `,
    ["role_user", pAuthTokenSelf, pSyncPush, pEntityCreate, pEntityUpdate],
  );
  await pool.query(
    `
      UPDATE role_permissions
      SET field_rules_write = $3::jsonb, row_filters_write = $4::jsonb
      WHERE role_id = $1 AND permission_id = $2
    `,
    ["role_user", pEntityUpdate, JSON.stringify({ deny: ["content"] }), JSON.stringify({ kind: "owner_only" })],
  );

  const schemaExists = await pool.query(
    "SELECT 1 FROM schemas WHERE name = 'core' AND status = 'released' LIMIT 1",
  );
  if (!schemaExists.rowCount) {
    const raw = await fs.readFile(seedSchemaPath, "utf8");
    const schema = JSON.parse(raw);
    schema.version = 1;
    await pool.query(
      "INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ('core', 1, 'released', $1, now())",
      [schema],
    );
  }

  await pool.query("DELETE FROM routing_policies WHERE tenant_id = $1", ["tenant_dev"]);
  await pool.query("DELETE FROM quota_limits WHERE tenant_id = $1", ["tenant_dev"]);
  await pool.query("DELETE FROM tool_limits WHERE tenant_id = $1", ["tenant_dev"]);
  await pool.query("DELETE FROM tool_rollouts WHERE tenant_id = $1", ["tenant_dev"]);
  await pool.query("DELETE FROM tool_active_versions WHERE tenant_id = $1", ["tenant_dev"]);
  await pool.query("DELETE FROM tool_active_overrides WHERE tenant_id = $1", ["tenant_dev"]);

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, display_name, scope, resource_type, action, idempotency_required, risk_level, approval_required)
      VALUES
        ($1, 'entity.create', $2, 'write', 'entity', 'create', true, 'high', true),
        ($1, 'entity.update', $3, 'write', 'entity', 'update', true, 'high', true),
        ($1, 'entity.delete', $4, 'write', 'entity', 'delete', true, 'high', true),
        ($1, 'collab.guard', $5, 'read', 'agent_runtime', 'collab.guard', false, 'low', false),
        ($1, 'collab.review', $6, 'write', 'agent_runtime', 'collab.review', true, 'low', false)
      ON CONFLICT (tenant_id, name) DO UPDATE
      SET display_name = COALESCE(tool_definitions.display_name, EXCLUDED.display_name),
          scope = COALESCE(tool_definitions.scope, EXCLUDED.scope),
          resource_type = COALESCE(tool_definitions.resource_type, EXCLUDED.resource_type),
          action = COALESCE(tool_definitions.action, EXCLUDED.action),
          idempotency_required = COALESCE(tool_definitions.idempotency_required, EXCLUDED.idempotency_required),
          risk_level = COALESCE(tool_definitions.risk_level, EXCLUDED.risk_level),
          approval_required = COALESCE(tool_definitions.approval_required, EXCLUDED.approval_required),
          updated_at = now()
    `,
    [
      "tenant_dev",
      { "zh-CN": "创建实体", "en-US": "Create entity" },
      { "zh-CN": "更新实体", "en-US": "Update entity" },
      { "zh-CN": "删除实体", "en-US": "Delete entity" },
      { "zh-CN": "协作守卫", "en-US": "Collab guard" },
      { "zh-CN": "协作复核", "en-US": "Collab review" },
    ],
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES
        ($1, 'entity.create', 1, 'entity.create@1', 'released', $2, $3),
        ($1, 'entity.update', 1, 'entity.update@1', 'released', $4, $5),
        ($1, 'entity.delete', 1, 'entity.delete@1', 'released', $6, $7),
        ($1, 'collab.guard', 1, 'collab.guard@1', 'released', $8, $9),
        ($1, 'collab.review', 1, 'collab.review@1', 'released', $10, $11)
      ON CONFLICT (tenant_id, name, version) DO NOTHING
    `,
    [
      "tenant_dev",
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, payload: { type: "json", required: true } } },
      { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true }, patch: { type: "json", required: true }, expectedRevision: { type: "number" } } },
      { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true } } },
      { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" }, deleted: { type: "boolean" } } },
      { fields: { plan: { type: "json", required: true }, roles: { type: "json" }, limits: { type: "json" }, evidence: { type: "json" } } },
      { fields: { allow: { type: "boolean" }, requiresApproval: { type: "boolean" }, blockedReasons: { type: "json" }, recommendedArbiterAction: { type: "string" } } },
      { fields: { taskId: { type: "string" }, mode: { type: "string" } } },
      { fields: { finalAnswer: { type: "string" }, citationsCount: { type: "number" }, nextActions: { type: "json" } } },
    ],
  );
}

// ─── 测试环境接口 ─────────────────────────────────────────────────────
export interface TestContext {
  app: FastifyInstance;
  canRun: boolean;
}

let sharedContext: TestContext | null = null;
let refCount = 0;
const prevWorkerApiBase = process.env.WORKER_API_BASE;
const prevApiBase = process.env.API_BASE;

/**
 * 获取共享测试上下文（单例模式）
 * 多个测试文件共享同一个服务器实例
 */
export async function getTestContext(): Promise<TestContext> {
  if (sharedContext) {
    refCount++;
    return sharedContext;
  }

  const app: any = buildServer(cfg, { db: pool, queue: { add: async () => ({}) } as any });
  let canRun = false;

  try {
    await migrate(pool, migrationsDir);
    await seed();
    await app.ready();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.WORKER_API_BASE = address;
    process.env.API_BASE = address;
    canRun = true;
  } catch (e) {
    app.log.error(e);
    canRun = false;
  }

  sharedContext = { app, canRun };
  refCount = 1;
  return sharedContext;
}

/**
 * 释放测试上下文
 */
export async function releaseTestContext(): Promise<void> {
  refCount--;
  if (refCount <= 0 && sharedContext) {
    await sharedContext.app.close();
    if (prevWorkerApiBase === undefined) delete process.env.WORKER_API_BASE;
    else process.env.WORKER_API_BASE = prevWorkerApiBase;
    if (prevApiBase === undefined) delete process.env.API_BASE;
    else process.env.API_BASE = prevApiBase;
    sharedContext = null;
  }
}

/**
 * 关闭数据库连接池
 */
export async function closePool(): Promise<void> {
  await pool.end();
}

// ─── 常用请求 Headers ─────────────────────────────────────────────────
export const adminHeaders = {
  authorization: "Bearer admin",
  "x-tenant-id": "tenant_dev",
  "x-space-id": "space_dev",
};

export function makeHeaders(subjectId: string = "admin", traceId?: string) {
  return {
    authorization: `Bearer ${subjectId}`,
    "x-tenant-id": "tenant_dev",
    "x-space-id": "space_dev",
    ...(traceId ? { "x-trace-id": traceId } : {}),
  };
}
