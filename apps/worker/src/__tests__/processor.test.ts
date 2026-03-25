import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { processStep } from "../workflow/processor";
import { computeSealedDigestV1 } from "../workflow/processor/sealed";
import { markWorkflowStepDeadletter } from "../workflow/deadletter";
import { processSubscriptionPoll } from "../subscriptions/processor";
import { tickWebhookDeliveries } from "../channels/webhookDelivery";
import { tickChannelOutboxDeliveries } from "../channels/outboxDelivery";
import { tickEmailDeliveries } from "../notifications/smtpDelivery";
import { encryptJson } from "../secrets/crypto";
import { decryptSecretPayload, encryptSecretEnvelopeWithKeyVersion } from "../secrets/envelope";
import { tickWorkflowStepPayloadPurge } from "../workflow/payloadPurge";
import { tickAuditSiemWebhookExport } from "../audit/siemWebhook";
import { buildSafeToolOutput, computeWriteLeaseResourceRef, isWriteLeaseTool, parseToolRef } from "../workflow/processor/tooling";

const cfg = loadConfig(process.env);
const pool = createPool(cfg);
const masterKey = cfg.secrets.masterKey;

const cwd = process.cwd();
const isWorkerCwd = cwd.replaceAll("\\", "/").endsWith("/apps/worker");
const migrationsDir = isWorkerCwd ? path.resolve(cwd, "../api/migrations") : path.resolve(cwd, "apps/api/migrations");
const seedSchemaPath = isWorkerCwd ? path.resolve(cwd, "../api/seed/core.schema.json") : path.resolve(cwd, "apps/api/seed/core.schema.json");

function withCapabilityEnvelope(input: any) {
  const tenantId = typeof input?.tenantId === "string" ? String(input.tenantId) : "tenant_dev";
  const spaceId = input?.spaceId ? String(input.spaceId) : null;
  const subjectId = input?.subjectId ? String(input.subjectId) : null;
  const tc = input?.toolContract && typeof input.toolContract === "object" && !Array.isArray(input.toolContract) ? input.toolContract : {};
  const env = {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId,
      spaceId,
      subjectId,
      toolContract: {
        scope: String((tc as any).scope ?? ""),
        resourceType: String((tc as any).resourceType ?? ""),
        action: String((tc as any).action ?? ""),
        fieldRules: (tc as any).fieldRules ?? null,
        rowFilters: (tc as any).rowFilters ?? null,
      },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: input?.networkPolicy ?? {} },
    resourceDomain: { limits: input?.limits ?? {} },
  };
  return { ...input, capabilityEnvelope: env };
}

async function migrate() {
  await pool.query("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
  for (const file of files) {
    const already = await pool.query("SELECT 1 FROM migrations WHERE id = $1", [file]);
    if (already.rowCount && already.rowCount > 0) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO migrations (id) VALUES ($1)", [file]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  }
}

async function seed() {
  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["tenant_dev"]);
  await pool.query("INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["space_dev", "tenant_dev"]);
  const masterKey = process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
  const pk = crypto.randomBytes(32).toString("base64");
  await pool.query(
    "INSERT INTO partition_keys (tenant_id, scope_type, scope_id, key_version, status, encrypted_key) VALUES ('tenant_dev','space','space_dev',1,'active',$1) ON CONFLICT (tenant_id, scope_type, scope_id, key_version) DO NOTHING",
    [JSON.stringify(encryptJson(masterKey, { k: pk }))],
  );

  const schemaExists = await pool.query("SELECT 1 FROM schemas WHERE name = 'core' AND status = 'released' LIMIT 1");
  if (!schemaExists.rowCount) {
    const raw = await fs.readFile(seedSchemaPath, "utf8");
    const schema = JSON.parse(raw);
    schema.version = 1;
    await pool.query(
      "INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ('core', 1, 'released', $1, now())",
      [schema],
    );
  }

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'entity.create', 'high', true)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES ('tenant_dev', 'entity.create', 1, 'entity.create@1', 'released', $1, $2)
      ON CONFLICT (tenant_id, name, version) DO NOTHING
    `,
    [
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, payload: { type: "json", required: true } } },
      { fields: { recordId: { type: "string" } } },
    ],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'entity.update', 'high', true)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES ('tenant_dev', 'entity.update', 1, 'entity.update@1', 'released', $1, $2)
      ON CONFLICT (tenant_id, name, version) DO NOTHING
    `,
    [
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true }, patch: { type: "json", required: true } } },
      { fields: { recordId: { type: "string" } } },
    ],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'entity.delete', 'high', true)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES ('tenant_dev', 'entity.delete', 1, 'entity.delete@1', 'released', $1, $2)
      ON CONFLICT (tenant_id, name, version) DO NOTHING
    `,
    [
      { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true } } },
      { fields: { recordId: { type: "string" }, deleted: { type: "boolean" } } },
    ],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'sleep', 'low', false)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema, artifact_ref)
      VALUES ('tenant_dev', 'sleep', 1, 'sleep@1', 'released', $1, $2, 'skills/sleep-skill')
      ON CONFLICT (tenant_id, name, version) DO UPDATE SET artifact_ref = EXCLUDED.artifact_ref
    `,
    [{ fields: { ms: { type: "number", required: true } } }, { fields: { sleptMs: { type: "number" } } }],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'http.get', 'medium', true)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema, artifact_ref)
      VALUES ('tenant_dev', 'http.get', 1, 'http.get@1', 'released', $1, $2, 'skills/http-fetch-skill')
      ON CONFLICT (tenant_id, name, version) DO UPDATE SET artifact_ref = EXCLUDED.artifact_ref
    `,
    [{ fields: { url: { type: "string", required: true } } }, { fields: { status: { type: "number" }, textLen: { type: "number" } } }],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'memory.write', 'low', false)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES ('tenant_dev', 'memory.write', 1, 'memory.write@1', 'released', $1, $2)
      ON CONFLICT (tenant_id, name, version) DO UPDATE SET
        tool_ref = EXCLUDED.tool_ref,
        status = EXCLUDED.status,
        input_schema = EXCLUDED.input_schema,
        output_schema = EXCLUDED.output_schema,
        updated_at = now()
    `,
    [
      { fields: { scope: { type: "string" }, type: { type: "string", required: true }, title: { type: "string" }, contentText: { type: "string", required: true }, writePolicy: { type: "string" }, retentionDays: { type: "number" } } },
      { fields: { entry: { type: "json" }, dlpSummary: { type: "json" } } },
    ],
  );

  await pool.query(
    `
      INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
      VALUES ('tenant_dev', 'memory.read', 'low', false)
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
    `,
  );
  await pool.query(
    `
      INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, input_schema, output_schema)
      VALUES ('tenant_dev', 'memory.read', 1, 'memory.read@1', 'released', $1, $2)
      ON CONFLICT (tenant_id, name, version) DO UPDATE SET
        tool_ref = EXCLUDED.tool_ref,
        status = EXCLUDED.status,
        input_schema = EXCLUDED.input_schema,
        output_schema = EXCLUDED.output_schema,
        updated_at = now()
    `,
    [
      { fields: { query: { type: "string", required: true }, scope: { type: "string" }, types: { type: "json" }, limit: { type: "number" } } },
      { fields: { evidence: { type: "json" }, candidateCount: { type: "number" }, evidenceCount: { type: "number" } } },
    ],
  );
}

function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

function stableStringify(v: any): string {
  return JSON.stringify(stableStringifyValue(v));
}

async function computeDepsDigest(artifactDir: string) {
  const raw = await fs.readFile(path.join(artifactDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  const entryRel = String(manifest?.entry ?? "");
  const entryBytes = entryRel ? await fs.readFile(path.join(artifactDir, entryRel)) : Buffer.from("");
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(stableStringify(manifest), "utf8"));
  h.update(Buffer.from("\n", "utf8"));
  h.update(entryBytes);
  return `sha256:${h.digest("hex")}`;
}

describe("sealed digest", () => {
  it("忽略 latencyMs 的变化", () => {
    const a = computeSealedDigestV1({ latencyMs: 12, outputKeys: { keys: ["a"], keyCount: 1 } });
    const b = computeSealedDigestV1({ latencyMs: 99, outputKeys: { keys: ["a"], keyCount: 1 } });
    expect(a).toEqual(b);
  });
});

describe("workflow tooling", () => {
  it("parseToolRef 能解析 name 与 version", () => {
    expect(parseToolRef("entity.create@1")).toEqual({ name: "entity.create", version: 1 });
    expect(parseToolRef("memory.write@12")).toEqual({ name: "memory.write", version: 12 });
  });

  it("isWriteLeaseTool 覆盖关键写工具", () => {
    expect(isWriteLeaseTool("entity.create")).toBe(true);
    expect(isWriteLeaseTool("entity.update")).toBe(true);
    expect(isWriteLeaseTool("entity.delete")).toBe(true);
    expect(isWriteLeaseTool("memory.write")).toBe(true);
    expect(isWriteLeaseTool("memory.read")).toBe(false);
  });

  it("computeWriteLeaseResourceRef 对 entity 与 memory 生成稳定资源键", () => {
    expect(computeWriteLeaseResourceRef({ toolName: "memory.write", spaceId: "space_dev", idempotencyKey: null, toolInput: {} })).toBe("memory:space_dev");
    expect(computeWriteLeaseResourceRef({ toolName: "entity.create", spaceId: "space_dev", idempotencyKey: "idem1", toolInput: { entityName: "notes" } })).toBe("entity:notes:create:idem1");
    expect(computeWriteLeaseResourceRef({ toolName: "entity.update", spaceId: "space_dev", idempotencyKey: null, toolInput: { entityName: "notes", id: "r1" } })).toBe("entity:notes:r1");
  });

  it("buildSafeToolOutput 对大字段做裁剪", () => {
    expect(buildSafeToolOutput("echo.tool", { a: "x".repeat(10000), b: 1 })).toBeNull();
    const out = buildSafeToolOutput("sleep", { sleptMs: 12, big: "x".repeat(10000) });
    expect(out).toEqual({ sleptMs: 12 });
  });
});

const hasDbEnv = Boolean(
  (process.env.POSTGRES_HOST ?? "").trim() ||
    (process.env.POSTGRES_DB ?? "").trim() ||
    (process.env.POSTGRES_USER ?? "").trim() ||
    (process.env.POSTGRES_PASSWORD ?? "").trim() ||
    (process.env.POSTGRES_PORT ?? "").trim(),
);

describe.skipIf(!hasDbEnv)("workflow processor", () => {
  let apiServer: http.Server | null = null;

  beforeAll(async () => {
    try {
      await migrate();
      await seed();
      apiServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const parts = url.pathname.split("/").filter(Boolean);
        const method = String(req.method ?? "GET").toUpperCase();
        const readBody = async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        };

        try {
          if (parts[0] === "entities" && parts.length >= 2) {
            const entityName = decodeURIComponent(parts[1] ?? "");
            const idempotencyKey = String(req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"] ?? "");
            if (!idempotencyKey) {
              res.statusCode = 400;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ errorCode: "BAD_REQUEST" }));
              return;
            }

            if (method === "POST" && parts.length === 2) {
              const prior = await pool.query(
                "SELECT record_id FROM idempotency_records WHERE tenant_id = 'tenant_dev' AND idempotency_key = $1 AND operation = 'create' AND entity_name = $2 LIMIT 1",
                [idempotencyKey, entityName],
              );
              if (prior.rowCount && prior.rows[0].record_id) {
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ id: String(prior.rows[0].record_id), recordId: String(prior.rows[0].record_id) }));
                return;
              }
              const payload = (await readBody()) ?? {};
              const inserted = await pool.query(
                "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id) VALUES ('tenant_dev','space_dev',$1,'core',1,$2,'admin') RETURNING id",
                [entityName, payload],
              );
              const recordId = String(inserted.rows[0].id);
              await pool.query(
                "INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, entity_name, record_id) VALUES ('tenant_dev',$1,'create',$2,$3) ON CONFLICT DO NOTHING",
                [idempotencyKey, entityName, recordId],
              );
              res.statusCode = 200;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ id: recordId, recordId }));
              return;
            }

            if ((method === "PATCH" || method === "DELETE") && parts.length === 3) {
              const id = decodeURIComponent(parts[2] ?? "");
              if (method === "PATCH") {
                const prior = await pool.query(
                  "SELECT record_id FROM idempotency_records WHERE tenant_id = 'tenant_dev' AND idempotency_key = $1 AND operation = 'update' AND entity_name = $2 LIMIT 1",
                  [idempotencyKey, entityName],
                );
                if (prior.rowCount && prior.rows[0].record_id) {
                  res.statusCode = 200;
                  res.setHeader("content-type", "application/json");
                  res.end(JSON.stringify({ id: String(prior.rows[0].record_id), recordId: String(prior.rows[0].record_id) }));
                  return;
                }
                const patch = (await readBody()) ?? {};
                const updated = await pool.query(
                  "UPDATE entity_records SET payload = payload || $1::jsonb, revision = revision + 1, updated_at = now() WHERE tenant_id = 'tenant_dev' AND space_id = 'space_dev' AND entity_name = $2 AND id = $3 RETURNING id",
                  [patch, entityName, id],
                );
                if (!updated.rowCount) {
                  res.statusCode = 409;
                  res.setHeader("content-type", "application/json");
                  res.end(JSON.stringify({ errorCode: "CONFLICT" }));
                  return;
                }
                const recordId = String(updated.rows[0].id);
                await pool.query(
                  "INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, entity_name, record_id) VALUES ('tenant_dev',$1,'update',$2,$3) ON CONFLICT DO NOTHING",
                  [idempotencyKey, entityName, recordId],
                );
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ id: recordId, recordId }));
                return;
              }

              if (method === "DELETE") {
                const prior = await pool.query(
                  "SELECT record_id FROM idempotency_records WHERE tenant_id = 'tenant_dev' AND idempotency_key = $1 AND operation = 'delete' AND entity_name = $2 LIMIT 1",
                  [idempotencyKey, entityName],
                );
                if (prior.rowCount && prior.rows[0].record_id) {
                  res.statusCode = 200;
                  res.setHeader("content-type", "application/json");
                  res.end(JSON.stringify({ id, recordId: id, deleted: true }));
                  return;
                }
                const del = await pool.query(
                  "DELETE FROM entity_records WHERE tenant_id = 'tenant_dev' AND space_id = 'space_dev' AND entity_name = $1 AND id = $2",
                  [entityName, id],
                );
                await pool.query(
                  "INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, entity_name, record_id) VALUES ('tenant_dev',$1,'delete',$2,$3) ON CONFLICT DO NOTHING",
                  [idempotencyKey, entityName, id],
                );
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ id, recordId: id, deleted: Number(del.rowCount ?? 0) > 0 }));
                return;
              }
            }
          }

          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ errorCode: "NOT_FOUND" }));
        } catch {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ errorCode: "INTERNAL" }));
        }
      });
      const port = await new Promise<number>((resolve) => {
        apiServer!.listen(0, "127.0.0.1", () => resolve((apiServer!.address() as any).port as number));
      });
      process.env.WORKER_API_BASE = `http://127.0.0.1:${port}`;
    } catch {
      return;
    }
  });

  afterAll(async () => {
    if (apiServer) {
      await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
      apiServer = null;
    }
    await pool.end();
  });

  it("执行 entity.create@1 并写入审计", async () => {
    const masterKey = process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
    const pk = crypto.randomBytes(32).toString("base64");
    await pool.query(
      "INSERT INTO partition_keys (tenant_id, scope_type, scope_id, key_version, status, encrypted_key) VALUES ('tenant_dev','space','space_dev',1,'active',$1) ON CONFLICT (tenant_id, scope_type, scope_id, key_version) DO NOTHING",
      [JSON.stringify(encryptJson(masterKey, { k: pk }))],
    );

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.create@1', $1, $2) RETURNING run_id",
      [{ toolRef: "entity.create@1" }, `idem-worker-1-${crypto.randomUUID()}`],
    );
    const fullInput = withCapabilityEnvelope({
      toolRef: "entity.create@1",
      traceId: "trace-worker-1",
      spaceId: "space_dev",
      subjectId: "admin",
      toolContract: { scope: "write", resourceType: "entity", action: "create", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
      limits: {},
      networkPolicy: { allowedDomains: [], rules: [] },
      input: { schemaName: "core", entityName: "notes", payload: { title: "w" } },
    });
    const env = await encryptSecretEnvelopeWithKeyVersion({
      pool,
      tenantId: "tenant_dev",
      masterKey,
      scopeType: "space",
      scopeId: "space_dev",
      keyVersion: 1,
      payload: fullInput,
    });
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest, input_enc_format, input_key_version, input_encrypted_payload) VALUES ($1, 1, 'pending', 'entity.create@1', $2, $3, 'envelope.v1', 1, $4) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          toolRef: "entity.create@1",
          traceId: "trace-worker-1",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: fullInput.toolContract,
          limits: fullInput.limits,
          networkPolicy: fullInput.networkPolicy,
          capabilityEnvelope: fullInput.capabilityEnvelope,
        },
        { toolRef: "entity.create@1" },
        env,
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query(
      "SELECT status, output, output_digest, compensation_enc_format, compensation_key_version, compensation_encrypted_payload FROM steps WHERE step_id = $1",
      [step.rows[0].step_id],
    );
    expect(s.rows[0].status).toBe("succeeded");
    expect(s.rows[0].output?.recordId).toBeTruthy();
    expect(s.rows[0].output_digest).toBeTruthy();
    expect(String(s.rows[0].compensation_enc_format)).toBe("envelope.v1");
    expect(Number(s.rows[0].compensation_key_version)).toBeGreaterThan(0);
    const comp = await decryptSecretPayload({
      pool,
      tenantId: "tenant_dev",
      masterKey,
      scopeType: "space",
      scopeId: "space_dev",
      keyVersion: Number(s.rows[0].compensation_key_version),
      encFormat: String(s.rows[0].compensation_enc_format),
      encryptedPayload: s.rows[0].compensation_encrypted_payload,
    });
    expect(String(comp?.undoToken?.kind ?? "")).toBe("entity.create");
    expect(String(comp?.compensatingToolRef ?? "")).toBe("entity.delete@1");

    const a = await pool.query(
      "SELECT 1 FROM audit_events WHERE resource_type = 'tool' AND action = 'execute' AND trace_id = $1 LIMIT 1",
      ["trace-worker-1"],
    );
    expect(a.rowCount).toBe(1);
  });

  it("workflow deadletter：标记 step deadletter 并写入审计", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'failed') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'failed', 'entity.create@1', $1, $2) RETURNING run_id",
      [{ toolRef: "entity.create@1" }, `idem-worker-dlq-1-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest, error_category, last_error) VALUES ($1, 1, 'failed', 'entity.create@1', $2, $3, 'retryable', 'boom') RETURNING step_id",
      [
        run.rows[0].run_id,
        { toolRef: "entity.create@1", traceId: "trace-worker-dlq-1", spaceId: "space_dev", subjectId: "admin", input: { schemaName: "core", entityName: "notes", payload: { title: "w" } } },
        { toolRef: "entity.create@1" },
      ],
    );

    const out = await markWorkflowStepDeadletter({
      pool,
      jobId: job.rows[0].job_id,
      runId: run.rows[0].run_id,
      stepId: step.rows[0].step_id,
      queueJobId: "q-dead-1",
      err: new Error("boom"),
    });
    expect(out?.traceId).toBe("trace-worker-dlq-1");

    const s = await pool.query("SELECT status, deadlettered_at, queue_job_id, last_error_digest FROM steps WHERE step_id = $1 LIMIT 1", [step.rows[0].step_id]);
    expect(String(s.rows[0].status)).toBe("deadletter");
    expect(s.rows[0].deadlettered_at).toBeTruthy();
    expect(String(s.rows[0].queue_job_id)).toBe("q-dead-1");
    expect(s.rows[0].last_error_digest).toBeTruthy();

    const a = await pool.query("SELECT 1 FROM audit_events WHERE resource_type = 'workflow' AND action = 'workflow:deadletter' AND trace_id = $1 LIMIT 1", ["trace-worker-dlq-1"]);
    expect(a.rowCount).toBe(1);
  });

  it("执行 memory.write@1：写入脱敏内容", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'memory.write@1', $1, $2) RETURNING run_id",
      [{ toolRef: "memory.write@1" }, `idem-mem-write-1-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest) VALUES ($1, 1, 'pending', 'memory.write@1', $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "memory.write@1",
          traceId: "trace-mem-write-1",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "write", resourceType: "memory", action: "write", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { scope: "user", type: "preference", title: "t", contentText: "hello sk_test_abcdef1234567890 world", writePolicy: "confirmed", retentionDays: 7 },
        }),
        { toolRef: "memory.write@1" },
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query("SELECT status, output FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("succeeded");
    const out = s.rows[0].output as any;
    expect(out?.entry?.id).toMatch(/./);

    const mem = await pool.query("SELECT content_text, retention_days FROM memory_entries WHERE id = $1", [out.entry.id]);
    expect(mem.rowCount).toBe(1);
    expect(String(mem.rows[0].content_text)).toContain("***REDACTED***");
    expect(String(mem.rows[0].content_text)).not.toContain("sk_test_");
    expect(mem.rows[0].retention_days).toBe(7);
  });

  it("执行 memory.read@1：返回片段且不泄露密钥", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'memory.read@1', $1, $2) RETURNING run_id",
      [{ toolRef: "memory.read@1" }, `idem-mem-read-1-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest) VALUES ($1, 1, 'pending', 'memory.read@1', $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "memory.read@1",
          traceId: "trace-mem-read-1",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "read", resourceType: "memory", action: "read", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { query: "hello", scope: "user", limit: 5 },
        }),
        { toolRef: "memory.read@1" },
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query("SELECT status, output, output_enc_format, output_key_version, output_encrypted_payload FROM steps WHERE step_id = $1", [
      step.rows[0].step_id,
    ]);
    expect(s.rows[0].status).toBe("succeeded");
    const out = s.rows[0].output as any;
    expect(Number(out?.evidenceCount ?? 0)).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("sk_test_");
    expect(String(s.rows[0].output_enc_format)).toBe("envelope.v1");
    expect(Number(s.rows[0].output_key_version)).toBeGreaterThan(0);
    const full = await decryptSecretPayload({
      pool,
      tenantId: "tenant_dev",
      masterKey: process.env.API_MASTER_KEY ?? "dev-master-key-change-me",
      scopeType: "space",
      scopeId: "space_dev",
      keyVersion: Number(s.rows[0].output_key_version),
      encFormat: String(s.rows[0].output_enc_format),
      encryptedPayload: s.rows[0].output_encrypted_payload,
    });
    expect((full?.evidence ?? []).length).toBeGreaterThan(0);
    expect(JSON.stringify(full)).not.toContain("sk_test_");
  });

  it("schema migration：不支持 kind 时稳定失败且不重试", async () => {
    const tenantId = `tenant_mig_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [tenantId]);

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ($1, 'schema.migration', 'queued') RETURNING job_id", [tenantId]);
    const run = await pool.query("INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ($1, 'created', 'schema.migration:test', $2, NULL) RETURNING run_id", [
      tenantId,
      { kind: "schema.migration" },
    ]);
    const mig = await pool.query(
      `
        INSERT INTO schema_migrations (tenant_id, scope_type, scope_id, schema_name, target_version, kind, plan_json, status, created_by_subject_id)
        VALUES ($1,'tenant',$1,'core',1,'unsupported_kind',$2::jsonb,'created','admin')
        RETURNING migration_id
      `,
      [tenantId, { batchSize: 1 }],
    );
    const migrationId = String(mig.rows[0].migration_id);
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest) VALUES ($1, 1, 'pending', NULL, $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        { kind: "schema.migration", migrationId, tenantId, scopeType: "tenant", scopeId: tenantId, schemaName: "core", targetVersion: 1, traceId: "t-mig-unsupported", subjectId: "admin" },
        { kind: "schema.migration", migrationId },
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);
    await pool.query(
      "INSERT INTO schema_migration_runs (tenant_id, migration_id, status, job_id, run_id, step_id) VALUES ($1,$2,'queued',$3,$4,$5)",
      [tenantId, migrationId, job.rows[0].job_id, run.rows[0].run_id, step.rows[0].step_id],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const runRow = await pool.query("SELECT status, last_error FROM schema_migration_runs WHERE tenant_id = $1 AND migration_id = $2 ORDER BY created_at DESC LIMIT 1", [tenantId, migrationId]);
    expect(String(runRow.rows[0].status)).toBe("failed");
    expect(String(runRow.rows[0].last_error ?? "")).toContain("MIGRATION_KIND_NOT_SUPPORTED");

    const s = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(String(s.rows[0].status)).toBe("failed");
    expect(String(s.rows[0].error_category)).toBe("policy_violation");
    expect(String(s.rows[0].last_error ?? "")).toContain("MIGRATION_KIND_NOT_SUPPORTED");

    const j = await pool.query("SELECT status FROM jobs WHERE job_id = $1", [job.rows[0].job_id]);
    expect(String(j.rows[0].status)).toBe("failed");
  });

  it("workflow step payload purge：过期清理密文并写审计", async () => {
    await pool.query("UPDATE tenants SET workflow_step_payload_retention_days = 0 WHERE id = 'tenant_dev'");
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'memory.read@1', $1, $2) RETURNING run_id",
      [{ toolRef: "memory.read@1" }, `idem-purge-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, output, output_enc_format, output_key_version, output_encrypted_payload, finished_at) VALUES ($1, 1, 'succeeded', 'memory.read@1', $2, $3, 'envelope.v1', 1, $4, now() - interval '2 days') RETURNING step_id",
      [
        run.rows[0].run_id,
        { toolRef: "memory.read@1", traceId: "trace-purge-1", spaceId: "space_dev", subjectId: "admin", input: { query: "hello", scope: "user", limit: 5 } },
        { candidateCount: 1 },
        await encryptSecretEnvelopeWithKeyVersion({ pool, tenantId: "tenant_dev", masterKey: process.env.API_MASTER_KEY ?? "dev-master-key-change-me", scopeType: "space", scopeId: "space_dev", keyVersion: 1, payload: { candidateCount: 2, evidence: [{ snippet: "x" }] } }),
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    const out = await tickWorkflowStepPayloadPurge({ pool, limit: 50 });
    expect(out.ok).toBe(true);
    expect(out.purgedCount).toBeGreaterThan(0);

    const s = await pool.query("SELECT output_enc_format, output_key_version, output_encrypted_payload FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(String(s.rows[0].output_enc_format)).toBe("envelope.v1");
    expect(Number(s.rows[0].output_key_version)).toBe(1);
    expect(s.rows[0].output_encrypted_payload).toBeNull();

    const audit = await pool.query("SELECT 1 FROM audit_events WHERE tenant_id = 'tenant_dev' AND action = 'workflow.step.payload.purge' LIMIT 1");
    expect(audit.rowCount).toBe(1);
  });

  it("执行 entity.update@1 并写入审计", async () => {
    const rec = await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id) VALUES ('tenant_dev', 'space_dev', 'notes', 'core', 1, $1, 'admin') RETURNING id",
      [{ title: "a" }],
    );
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.update@1', $1, $2) RETURNING run_id",
      [{ toolRef: "entity.update@1" }, `idem-worker-2-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest) VALUES ($1, 1, 'pending', 'entity.update@1', $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "entity.update@1",
          traceId: "trace-worker-2",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "write", resourceType: "entity", action: "update", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { schemaName: "core", entityName: "notes", id: rec.rows[0].id, patch: { title: "b" } },
        }),
        { toolRef: "entity.update@1" },
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query("SELECT status, output FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("succeeded");
    expect(s.rows[0].output?.recordId).toBe(rec.rows[0].id);
  });

  it("拒绝未发布工具版本（policy_violation）", async () => {
    const toolRef = `bad.tool.${crypto.randomUUID()}@1`;
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', $1, $2, $3) RETURNING run_id",
      [toolRef, { toolRef }, `idem-worker-3-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input, input_digest) VALUES ($1, 1, 'pending', $2, $3, $4) RETURNING step_id",
      [
        run.rows[0].run_id,
        toolRef,
        withCapabilityEnvelope({
          toolRef,
          traceId: "trace-worker-3",
          spaceId: "space_dev",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: {},
        }),
        { toolRef },
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
    const s = await pool.query("SELECT status, error_category FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("policy_violation");
  });

  it("缺失 capabilityEnvelope：拒绝执行且写审计摘要（worker）", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'sleep@1', $1, $2) RETURNING run_id",
      [{ toolRef: "sleep@1" }, `idem-cap-missing-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'sleep@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          toolRef: "sleep@1",
          traceId: "trace-cap-missing",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: { timeoutMs: 1000, maxConcurrency: 10 },
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { ms: 1 },
        },
      ],
    );
    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
    const s = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("policy_violation");
    expect(String(s.rows[0].last_error ?? "")).toBe("policy_violation:capability_envelope_missing");
    const a = await pool.query("SELECT output_digest FROM audit_events WHERE trace_id = $1 ORDER BY timestamp DESC, event_id DESC LIMIT 1", ["trace-cap-missing"]);
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].output_digest?.capabilityEnvelopeSummary?.status).toBe("missing");
  });

  it("不合法 capabilityEnvelope：拒绝执行且写审计摘要（worker）", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'sleep@1', $1, $2) RETURNING run_id",
      [{ toolRef: "sleep@1" }, `idem-cap-invalid-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'sleep@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          toolRef: "sleep@1",
          traceId: "trace-cap-invalid",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: { timeoutMs: 1000, maxConcurrency: 10 },
          networkPolicy: { allowedDomains: [], rules: [] },
          capabilityEnvelope: { format: "capabilityEnvelope.v0" },
          input: { ms: 1 },
        },
      ],
    );
    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
    const s = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("policy_violation");
    expect(String(s.rows[0].last_error ?? "")).toBe("policy_violation:capability_envelope_invalid");
    const a = await pool.query("SELECT output_digest FROM audit_events WHERE trace_id = $1 ORDER BY timestamp DESC, event_id DESC LIMIT 1", ["trace-cap-invalid"]);
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].output_digest?.capabilityEnvelopeSummary?.status).toBe("invalid");
  });

  it("timeoutMs 超时生效（timeout）", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'sleep@1', $1, $2) RETURNING run_id",
      [{ toolRef: "sleep@1" }, `idem-timeout-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'sleep@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "sleep@1",
          traceId: "trace-timeout",
          spaceId: "space_dev",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: { timeoutMs: 10, maxConcurrency: 10 },
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { ms: 50 },
        }),
      ],
    );

    await expect(processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id })).rejects.toBeTruthy();
    const s = await pool.query("SELECT status, error_category FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("timeout");

    const a = await pool.query("SELECT output_digest FROM audit_events WHERE trace_id = $1 ORDER BY timestamp DESC, event_id DESC LIMIT 1", ["trace-timeout"]);
    expect(a.rowCount).toBe(1);
    expect(String(a.rows[0].output_digest?.error ?? "")).toBe("timeout");
  });

  it("maxConcurrency 并发限制生效（resource_exhausted）", async () => {
    const mk = async (traceId: string) => {
      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const run = await pool.query(
        "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'sleep@1', $1, $2) RETURNING run_id",
        [{ toolRef: "sleep@1" }, `idem-conc-${crypto.randomUUID()}`],
      );
      const step = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'sleep@1', $2) RETURNING step_id",
        [
          run.rows[0].run_id,
          withCapabilityEnvelope({
            toolRef: "sleep@1",
            traceId,
            spaceId: "space_dev",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: { timeoutMs: 1000, maxConcurrency: 1 },
            networkPolicy: { allowedDomains: [], rules: [] },
            input: { ms: 200 },
          }),
        ],
      );
      return { jobId: job.rows[0].job_id as string, runId: run.rows[0].run_id as string, stepId: step.rows[0].step_id as string };
    };

    const a = await mk("trace-conc-a");
    const b = await mk("trace-conc-b");

    const r = await Promise.allSettled([processStep({ pool, masterKey, ...a }), processStep({ pool, masterKey, ...b })]);
    expect(r.some((x) => x.status === "fulfilled")).toBe(true);
    expect(r.some((x) => x.status === "rejected")).toBe(true);

    const rows = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id IN ($1,$2)", [a.stepId, b.stepId]);
    const failed = rows.rows.find((x: any) => x.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed.error_category).toBe("resource_exhausted");
    expect(String(failed.last_error)).toBe("resource_exhausted:max_concurrency");

    const a2 = await pool.query("SELECT trace_id, output_digest FROM audit_events WHERE result = 'error' AND trace_id IN ($1,$2) ORDER BY timestamp DESC, event_id DESC", [
      "trace-conc-a",
      "trace-conc-b",
    ]);
    expect(a2.rowCount).toBeGreaterThan(0);
    const e = a2.rows.find((x: any) => String(x.trace_id) === "trace-conc-a" || String(x.trace_id) === "trace-conc-b");
    expect(e).toBeTruthy();
    const s2 = JSON.stringify(e.output_digest ?? {});
    expect(s2).toContain("resource_exhausted:max_concurrency");
  });

  it("maxOutputBytes 输出超限生效且审计仅摘要（resource_exhausted）", async () => {
    const repoRoot = isWorkerCwd ? path.resolve(cwd, "../..") : cwd;
    process.env.SKILL_PACKAGE_ROOTS = path.resolve(repoRoot, "skills");
    const artifactDir = path.resolve(repoRoot, "skills/echo-skill");
    const depsDigest = await computeDepsDigest(artifactDir);

    await pool.query(
      `
        INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
        VALUES ('tenant_dev', 'echo.tool', 'low', false)
        ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
      `,
    );
    await pool.query(
      `
        INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, input_schema, output_schema)
        VALUES ('tenant_dev', 'echo.tool', 1, 'echo.tool@1', 'released', $1, $2, $3, $4)
        ON CONFLICT (tenant_id, name, version) DO UPDATE SET deps_digest = EXCLUDED.deps_digest, artifact_ref = EXCLUDED.artifact_ref
      `,
      [
        depsDigest,
        artifactDir,
        { fields: { text: { type: "string", required: true } } },
        { fields: { echo: { type: "string", required: true } } },
      ],
    );

    const marker = "LARGE_PAYLOAD_SECRET";
    const large = `${marker}:${"x".repeat(5000)}`;
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query("INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', $1, $2, NULL) RETURNING run_id", [
      "echo.tool@1",
      { toolRef: "echo.tool@1" },
    ]);
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        "echo.tool@1",
        withCapabilityEnvelope({
          toolRef: "echo.tool@1",
          input: { text: large },
          tenantId: "tenant_dev",
          spaceId: "space_dev",
          subjectId: "s1",
          traceId: "trace-max-output",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: { timeoutMs: 5000, maxConcurrency: 10, maxOutputBytes: 400 },
          networkPolicy: { allowedDomains: [], rules: [] },
        }),
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    await expect(processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id })).rejects.toBeTruthy();
    const s = await pool.query("SELECT status, error_category, last_error, output FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(String(s.rows[0].status)).toBe("failed");
    expect(String(s.rows[0].error_category)).toBe("resource_exhausted");
    expect(String(s.rows[0].last_error)).toBe("resource_exhausted:max_output_bytes");
    expect(s.rows[0].output ?? null).toBeNull();
    expect(String(s.rows[0].last_error)).not.toContain(marker);

    const a = await pool.query("SELECT output_digest FROM audit_events WHERE trace_id = $1 ORDER BY timestamp DESC, event_id DESC LIMIT 1", ["trace-max-output"]);
    expect(a.rowCount).toBe(1);
    const outStr = JSON.stringify(a.rows[0].output_digest ?? {});
    expect(outStr).toContain("resource_exhausted:max_output_bytes");
    expect(outStr).not.toContain(marker);
  });

  it("write lease busy：并发写被阻断（retryable）", async () => {
    const rec = await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id) VALUES ('tenant_dev', 'space_dev', 'notes', 'core', 1, $1, 'admin') RETURNING id",
      [{ title: "a" }],
    );
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.update@1', $1, $2) RETURNING run_id",
      [{ toolRef: "entity.update@1" }, `idem-write-lease-busy-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'entity.update@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "entity.update@1",
          traceId: "trace-write-lease-busy",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "write", resourceType: "entity", action: "update", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { schemaName: "core", entityName: "notes", id: rec.rows[0].id, patch: { title: "b" } },
        }),
      ],
    );

    await pool.query(
      `
        INSERT INTO workflow_write_leases (tenant_id, space_id, resource_ref, owner_run_id, owner_step_id, owner_trace_id, expires_at)
        VALUES ('tenant_dev', 'space_dev', $1, 'r1', 's1', 't1', now() + interval '60 seconds')
      `,
      [`entity:notes:${rec.rows[0].id}`],
    );

    await expect(processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id })).rejects.toBeTruthy();
    const s = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("retryable");
    expect(String(s.rows[0].last_error)).toBe("write_lease_busy");
  });

  it("write lease TTL：过期后可重新获取并释放", async () => {
    const rec = await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload, owner_subject_id) VALUES ('tenant_dev', 'space_dev', 'notes', 'core', 1, $1, 'admin') RETURNING id",
      [{ title: "a" }],
    );
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.update@1', $1, $2) RETURNING run_id",
      [{ toolRef: "entity.update@1" }, `idem-write-lease-ttl-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'entity.update@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "entity.update@1",
          traceId: "trace-write-lease-ttl",
          spaceId: "space_dev",
          subjectId: "admin",
          toolContract: { scope: "write", resourceType: "entity", action: "update", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { schemaName: "core", entityName: "notes", id: rec.rows[0].id, patch: { title: "b" } },
        }),
      ],
    );

    await pool.query(
      `
        INSERT INTO workflow_write_leases (tenant_id, space_id, resource_ref, owner_run_id, owner_step_id, owner_trace_id, expires_at)
        VALUES ('tenant_dev', 'space_dev', $1, 'r1', 's1', 't1', now() - interval '1 second')
      `,
      [`entity:notes:${rec.rows[0].id}`],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query("SELECT status FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("succeeded");
    const lease = await pool.query("SELECT 1 FROM workflow_write_leases WHERE tenant_id = 'tenant_dev' AND space_id = 'space_dev' AND resource_ref = $1 LIMIT 1", [
      `entity:notes:${rec.rows[0].id}`,
    ]);
    expect(lease.rowCount).toBe(0);
  });

  it("默认拒绝出站（policy_violation）", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'http.get@1', $1, $2) RETURNING run_id",
      [{ toolRef: "http.get@1" }, `idem-egress-deny-${crypto.randomUUID()}`],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'http.get@1', $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        withCapabilityEnvelope({
          toolRef: "http.get@1",
          traceId: "trace-egress-deny",
          spaceId: "space_dev",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
          input: { url: "http://127.0.0.1/" },
        }),
      ],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
    const s = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
    expect(s.rows[0].status).toBe("failed");
    expect(s.rows[0].error_category).toBe("policy_violation");
    expect(String(s.rows[0].last_error)).toContain("egress_denied");
  });

  it("allowedDomains 放行出站并产出 egressSummary", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    try {
      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const run = await pool.query(
        "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'http.get@1', $1, $2) RETURNING run_id",
        [{ toolRef: "http.get@1" }, `idem-egress-allow-${crypto.randomUUID()}`],
      );
      const step = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'http.get@1', $2) RETURNING step_id",
        [
          run.rows[0].run_id,
          withCapabilityEnvelope({
            toolRef: "http.get@1",
            traceId: "trace-egress-allow",
            spaceId: "space_dev",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: { timeoutMs: 2000, maxConcurrency: 10 },
            networkPolicy: { allowedDomains: ["127.0.0.1"] },
            input: { url: `http://127.0.0.1:${port}/` },
          }),
        ],
      );

      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
      const s = await pool.query("SELECT status, output, output_digest FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
      expect(s.rows[0].status).toBe("succeeded");
      expect(s.rows[0].output?.status).toBe(200);
      expect(s.rows[0].output_digest?.egressSummary?.length).toBeGreaterThan(0);
      expect(s.rows[0].output_digest.egressSummary[0].allowed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rules 支持按 pathPrefix 放行/拒绝", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });
    try {
      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const runOk = await pool.query(
        "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'http.get@1', $1, $2) RETURNING run_id",
        [{ toolRef: "http.get@1" }, `idem-egress-rules-ok-${crypto.randomUUID()}`],
      );
      const stepOk = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'http.get@1', $2) RETURNING step_id",
        [
          runOk.rows[0].run_id,
          withCapabilityEnvelope({
            toolRef: "http.get@1",
            traceId: "trace-egress-rules-ok",
            spaceId: "space_dev",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: {},
            networkPolicy: { allowedDomains: [], rules: [{ host: "127.0.0.1", pathPrefix: "/ok", methods: ["GET"] }] },
            input: { url: `http://127.0.0.1:${port}/ok` },
          }),
        ],
      );
      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: runOk.rows[0].run_id, stepId: stepOk.rows[0].step_id });
      const sOk = await pool.query("SELECT status, output_digest FROM steps WHERE step_id = $1", [stepOk.rows[0].step_id]);
      expect(sOk.rows[0].status).toBe("succeeded");
      expect(sOk.rows[0].output_digest?.egressSummary?.[0]?.allowed).toBe(true);

      const runBad = await pool.query(
        "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'http.get@1', $1, $2) RETURNING run_id",
        [{ toolRef: "http.get@1" }, `idem-egress-rules-bad-${crypto.randomUUID()}`],
      );
      const stepBad = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'http.get@1', $2) RETURNING step_id",
        [
          runBad.rows[0].run_id,
          withCapabilityEnvelope({
            toolRef: "http.get@1",
            traceId: "trace-egress-rules-bad",
            spaceId: "space_dev",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: {},
            networkPolicy: { allowedDomains: [], rules: [{ host: "127.0.0.1", pathPrefix: "/ok", methods: ["GET"] }] },
            input: { url: `http://127.0.0.1:${port}/bad` },
          }),
        ],
      );
      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: runBad.rows[0].run_id, stepId: stepBad.rows[0].step_id });
      const sBad = await pool.query("SELECT status, error_category, last_error FROM steps WHERE step_id = $1", [stepBad.rows[0].step_id]);
      expect(sBad.rows[0].status).toBe("failed");
      expect(sBad.rows[0].error_category).toBe("policy_violation");
      expect(String(sBad.rows[0].last_error)).toContain("egress_denied");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rules 支持按 methods 放行/拒绝（动态 skill fetch）", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });
    const tmpRoot = await fs.mkdtemp(path.join(cwd, "tmp-skill-"));
    const artifactDir = path.join(tmpRoot, "skill");
    await fs.mkdir(path.join(artifactDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, "manifest.json"),
      JSON.stringify(
        {
          identity: { name: "egress.method.skill", version: "1.0.0" },
          contract: { scope: "read", resourceType: "tool", action: "execute", idempotencyRequired: false, riskLevel: "low", approvalRequired: false },
          io: { inputSchema: { fields: { url: { type: "string", required: true } } }, outputSchema: { fields: { status: { type: "number", required: true } } } },
          entry: "dist/index.js",
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(artifactDir, "dist/index.js"),
      `exports.execute = async (req) => { const r = await fetch(req.input.url, { method: 'POST' }); return { status: r.status }; };`,
    );
    process.env.SKILL_PACKAGE_ROOTS = tmpRoot;
    const depsDigest = await computeDepsDigest(artifactDir);

    await pool.query(
      `
        INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
        VALUES ('tenant_dev', 'egress.method.skill', 'low', false)
        ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
      `,
    );
    await pool.query(
      `
        INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, input_schema, output_schema)
        VALUES ('tenant_dev', 'egress.method.skill', 1, 'egress.method.skill@1', 'released', $1, $2, $3, $4)
        ON CONFLICT (tenant_id, name, version) DO UPDATE SET deps_digest = EXCLUDED.deps_digest, artifact_ref = EXCLUDED.artifact_ref
      `,
      [depsDigest, artifactDir, { fields: { url: { type: "string", required: true } } }, { fields: { status: { type: "number", required: true } } }],
    );

    try {
      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const run = await pool.query(
        "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'egress.method.skill@1', $1, $2) RETURNING run_id",
        [{ toolRef: "egress.method.skill@1" }, `idem-egress-method-${crypto.randomUUID()}`],
      );
      const step = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', 'egress.method.skill@1', $2) RETURNING step_id",
        [
          run.rows[0].run_id,
          withCapabilityEnvelope({
            toolRef: "egress.method.skill@1",
            traceId: "trace-egress-method",
            spaceId: "space_dev",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: {},
            networkPolicy: { allowedDomains: [], rules: [{ host: "127.0.0.1", pathPrefix: "/ok", methods: ["POST"] }] },
            input: { url: `http://127.0.0.1:${port}/ok` },
          }),
        ],
      );
      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });
      const s = await pool.query("SELECT status, output_digest FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
      expect(s.rows[0].status).toBe("succeeded");
      expect(s.rows[0].output_digest?.egressSummary?.[0]?.allowed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("支持动态加载 skill 包并校验 depsDigest", async () => {
    const repoRoot = isWorkerCwd ? path.resolve(cwd, "../..") : cwd;
    process.env.SKILL_PACKAGE_ROOTS = path.resolve(repoRoot, "skills");
    const artifactDir = path.resolve(repoRoot, "skills/echo-skill");
    const depsDigest = await computeDepsDigest(artifactDir);

    await pool.query(
      `
        INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
        VALUES ('tenant_dev', 'echo.tool', 'low', false)
        ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
      `,
    );
    await pool.query(
      `
        INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, input_schema, output_schema)
        VALUES ('tenant_dev', 'echo.tool', 1, 'echo.tool@1', 'released', $1, $2, $3, $4)
        ON CONFLICT (tenant_id, name, version) DO UPDATE SET deps_digest = EXCLUDED.deps_digest, artifact_ref = EXCLUDED.artifact_ref
      `,
      [
        depsDigest,
        artifactDir,
        { fields: { text: { type: "string", required: true } } },
        { fields: { echo: { type: "string", required: true } } },
      ],
    );

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
    const run = await pool.query("INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', $1, $2, $3) RETURNING run_id", [
      "echo.tool@1",
      { toolRef: "echo.tool@1" },
      null,
    ]);
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', $2, $3) RETURNING step_id",
      [
        run.rows[0].run_id,
        "echo.tool@1",
        withCapabilityEnvelope({
          toolRef: "echo.tool@1",
          input: { text: "hi" },
          tenantId: "tenant_dev",
          spaceId: "space_dev",
          subjectId: "s1",
          traceId: "t-dyn-skill",
          toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
          limits: {},
          networkPolicy: { allowedDomains: [], rules: [] },
        }),
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const s = await pool.query("SELECT status, output, output_digest, output_enc_format, output_key_version, output_encrypted_payload FROM steps WHERE step_id = $1", [
      step.rows[0].step_id,
    ]);
    expect(s.rows[0].status).toBe("succeeded");
    expect(s.rows[0].output?.echo).toBeUndefined();
    const full = await decryptSecretPayload({
      pool,
      tenantId: "tenant_dev",
      masterKey: process.env.API_MASTER_KEY ?? "dev-master-key-change-me",
      scopeType: "space",
      scopeId: "space_dev",
      keyVersion: Number(s.rows[0].output_key_version),
      encFormat: String(s.rows[0].output_enc_format),
      encryptedPayload: s.rows[0].output_encrypted_payload,
    });
    expect(full.echo).toBe("hi");
    expect(s.rows[0].output_digest.artifactRef).toBe(artifactDir);
    expect(s.rows[0].output_digest.depsDigest).toBe(depsDigest);
  });

  it("dynamic skill：强制 remote 且无 runner 时拒绝执行", async () => {
    const prevBackend = process.env.SKILL_RUNTIME_BACKEND;
    const prevEndpoint = process.env.SKILL_RUNTIME_REMOTE_ENDPOINT;
    process.env.SKILL_RUNTIME_BACKEND = "remote";
    delete process.env.SKILL_RUNTIME_REMOTE_ENDPOINT;

    try {
      const repoRoot = isWorkerCwd ? path.resolve(cwd, "../..") : cwd;
      process.env.SKILL_PACKAGE_ROOTS = path.resolve(repoRoot, "skills");
      const artifactDir = path.resolve(repoRoot, "skills/echo-skill");
      const depsDigest = await computeDepsDigest(artifactDir);

      await pool.query("DELETE FROM skill_runtime_runners WHERE tenant_id = 'tenant_dev'");
      const runnerCount = await pool.query("SELECT COUNT(*)::int AS c FROM skill_runtime_runners WHERE tenant_id = 'tenant_dev' AND enabled = true");
      expect(Number(runnerCount.rows[0].c)).toBe(0);
      expect(process.env.SKILL_RUNTIME_REMOTE_ENDPOINT).toBeUndefined();

      await pool.query(
        `
          INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
          VALUES ('tenant_dev', 'echo.tool', 'low', false)
          ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
        `,
      );
      await pool.query(
        `
          INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, input_schema, output_schema)
          VALUES ('tenant_dev', 'echo.tool', 1, 'echo.tool@1', 'released', $1, $2, $3, $4)
          ON CONFLICT (tenant_id, name, version) DO UPDATE SET deps_digest = EXCLUDED.deps_digest, artifact_ref = EXCLUDED.artifact_ref
        `,
        [depsDigest, artifactDir, { fields: { text: { type: "string", required: true } } }, { fields: { echo: { type: "string", required: true } } }],
      );

      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const run = await pool.query("INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', $1, $2, $3) RETURNING run_id", [
        "echo.tool@1",
        { toolRef: "echo.tool@1" },
        `idem-remote-missing-${crypto.randomUUID()}`,
      ]);
      const step = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', $2, $3) RETURNING step_id",
        [
          run.rows[0].run_id,
          "echo.tool@1",
          withCapabilityEnvelope({
            toolRef: "echo.tool@1",
            input: { text: "hi" },
            tenantId: "tenant_dev",
            spaceId: "space_dev",
            subjectId: "s1",
            traceId: "t-remote-missing",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: {},
            networkPolicy: { allowedDomains: [], rules: [] },
          }),
        ],
      );
      await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

      const s = await pool.query("SELECT status, error_category, last_error, output_digest FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
      expect(String(s.rows[0].status)).toBe("failed");
      expect(String(s.rows[0].error_category)).toBe("policy_violation");
      expect(String(s.rows[0].last_error ?? "")).toBe("policy_violation:remote_runtime_not_configured");
      expect(String(s.rows[0].output_digest?.runtimeBackend ?? "")).not.toBe("remote");
    } finally {
      process.env.SKILL_RUNTIME_BACKEND = prevBackend;
      if (prevEndpoint === undefined) delete process.env.SKILL_RUNTIME_REMOTE_ENDPOINT;
      else process.env.SKILL_RUNTIME_REMOTE_ENDPOINT = prevEndpoint;
    }
  });

  it("dynamic skill：设置 remote endpoint override 时不依赖 runner registry", async () => {
    const prevBackend = process.env.SKILL_RUNTIME_BACKEND;
    const prevEndpoint = process.env.SKILL_RUNTIME_REMOTE_ENDPOINT;
    process.env.SKILL_RUNTIME_BACKEND = "remote";
    process.env.SKILL_RUNTIME_REMOTE_ENDPOINT = "http://remote-runner.local/execute";

    const repoRoot = isWorkerCwd ? path.resolve(cwd, "../..") : cwd;
    process.env.SKILL_PACKAGE_ROOTS = path.resolve(repoRoot, "skills");
    const artifactDir = path.resolve(repoRoot, "skills/echo-skill");
    const depsDigest = await computeDepsDigest(artifactDir);

    await pool.query("DELETE FROM skill_runtime_runners WHERE tenant_id = 'tenant_dev'");

    await pool.query(
      `
        INSERT INTO tool_definitions (tenant_id, name, risk_level, approval_required)
        VALUES ('tenant_dev', 'echo.tool', 'low', false)
        ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
      `,
    );
    await pool.query(
      `
        INSERT INTO tool_versions (tenant_id, name, version, tool_ref, status, deps_digest, artifact_ref, input_schema, output_schema)
        VALUES ('tenant_dev', 'echo.tool', 1, 'echo.tool@1', 'released', $1, $2, $3, $4)
        ON CONFLICT (tenant_id, name, version) DO UPDATE SET deps_digest = EXCLUDED.deps_digest, artifact_ref = EXCLUDED.artifact_ref
      `,
      [depsDigest, artifactDir, { fields: { text: { type: "string", required: true } } }, { fields: { echo: { type: "string", required: true } } }],
    );

    const origFetch = (globalThis as any).fetch;
    const fetchStub = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe("http://remote-runner.local/execute");
      expect(String(init?.method ?? "")).toBe("POST");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(String(body.toolRef)).toBe("echo.tool@1");
      expect(String(body.depsDigest)).toBe(depsDigest);
      return new Response(JSON.stringify({ ok: true, output: { echo: body.input.text }, egress: [], depsDigest }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub as any);

    try {
      const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'tool.execute', 'queued') RETURNING job_id");
      const run = await pool.query("INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', $1, $2, $3) RETURNING run_id", [
        "echo.tool@1",
        { toolRef: "echo.tool@1" },
        `idem-remote-override-${crypto.randomUUID()}`,
      ]);
      const step = await pool.query(
        "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', $2, $3) RETURNING step_id",
        [
          run.rows[0].run_id,
          "echo.tool@1",
          withCapabilityEnvelope({
            toolRef: "echo.tool@1",
            input: { text: "hi-remote" },
            tenantId: "tenant_dev",
            spaceId: "space_dev",
            subjectId: "s1",
            traceId: "t-remote-override",
            toolContract: { scope: "read", resourceType: "tool", action: "execute", fieldRules: { read: { allow: ["*"] }, write: { allow: ["*"] } }, rowFilters: null },
            limits: {},
            networkPolicy: { allowedDomains: [], rules: [] },
          }),
        ],
      );
      await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

      await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

      const s = await pool.query("SELECT status, output, output_digest FROM steps WHERE step_id = $1", [step.rows[0].step_id]);
      expect(String(s.rows[0].status)).toBe("succeeded");
      expect(s.rows[0].output?.echo).toBeUndefined();
      expect(String(s.rows[0].output_digest?.runtimeBackend ?? "")).toBe("remote");
    } finally {
      vi.stubGlobal("fetch", origFetch as any);
      process.env.SKILL_RUNTIME_BACKEND = prevBackend;
      if (prevEndpoint === undefined) delete process.env.SKILL_RUNTIME_REMOTE_ENDPOINT;
      else process.env.SKILL_RUNTIME_REMOTE_ENDPOINT = prevEndpoint;
    }
  });

  it("执行 entity.export 并生成 export artifact", async () => {
    await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload) VALUES ('tenant_dev','space_dev','notes','core',1,$1)",
      [{ title: "Export A", content: "c1" }],
    );

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'entity.export', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.export:notes', $1, NULL) RETURNING run_id",
      [{ entityName: "notes" }],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', NULL, $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          kind: "entity.export",
          entityName: "notes",
          schemaName: "core",
          query: { filters: { field: "title", op: "contains", value: "Export" } },
          select: ["title"],
          format: "jsonl",
          fieldRules: { read: { allow: ["*"], deny: [] }, write: { allow: ["*"], deny: [] } },
          tenantId: "tenant_dev",
          spaceId: "space_dev",
          subjectId: "admin",
          traceId: "t-export",
        },
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const art = await pool.query("SELECT type, content_text FROM artifacts WHERE tenant_id = 'tenant_dev' AND run_id = $1 ORDER BY created_at DESC LIMIT 1", [
      run.rows[0].run_id,
    ]);
    expect(art.rowCount).toBe(1);
    expect(art.rows[0].type).toBe("export");
    const lines = String(art.rows[0].content_text)
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const first = JSON.parse(lines[0]);
    expect(first.payload.title).toBeTruthy();
    expect(first.payload.content).toBeUndefined();
  });

  it("执行 entity.import 并生成 import_report artifact", async () => {
    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'entity.import', 'queued') RETURNING job_id");
    const idem = `idem-import-${crypto.randomUUID()}`;
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'entity.import:notes', $1, $2) RETURNING run_id",
      [{ entityName: "notes" }, idem],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', NULL, $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          kind: "entity.import",
          entityName: "notes",
          schemaName: "core",
          format: "jsonl",
          records: [{ title: "Bulk 1" }, { title: 1 }],
          fieldRules: { read: { allow: ["*"], deny: [] }, write: { allow: ["*"], deny: [] } },
          tenantId: "tenant_dev",
          spaceId: "space_dev",
          subjectId: "admin",
          traceId: "t-import",
        },
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const art = await pool.query(
      "SELECT type, content_text FROM artifacts WHERE tenant_id = 'tenant_dev' AND run_id = $1 AND type = 'import_report' ORDER BY created_at DESC LIMIT 1",
      [run.rows[0].run_id],
    );
    expect(art.rowCount).toBe(1);
    const report = JSON.parse(String(art.rows[0].content_text));
    expect(report.acceptedCount).toBe(1);
    expect(report.rejectedCount).toBe(1);

    const exists = await pool.query(
      "SELECT 1 FROM entity_records WHERE tenant_id = 'tenant_dev' AND space_id = 'space_dev' AND entity_name = 'notes' AND payload->>'title' = $1 LIMIT 1",
      ["Bulk 1"],
    );
    expect(exists.rowCount).toBe(1);
  });

  it("执行 space.backup 并生成 backup artifact 与 backups 记录", async () => {
    await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload) VALUES ('tenant_dev','space_dev','notes','core',1,$1)",
      [{ title: "Backup A", content: "c1" }],
    );

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'space.backup', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'space.backup:space_dev', $1, NULL) RETURNING run_id",
      [{ spaceId: "space_dev" }],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', NULL, $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          kind: "space.backup",
          spaceId: "space_dev",
          schemaName: "core",
          entityNames: ["notes"],
          format: "jsonl",
          fieldRules: { read: { allow: ["*"], deny: [] }, write: { allow: ["*"], deny: [] } },
          tenantId: "tenant_dev",
          subjectId: "admin",
          traceId: "t-space-backup",
        },
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);
    const backup = await pool.query(
      "INSERT INTO backups (tenant_id, space_id, status, schema_name, entity_names, format, run_id, step_id, created_by_subject_id) VALUES ('tenant_dev','space_dev','created','core',$1::jsonb,'jsonl',$2,$3,'admin') RETURNING backup_id",
      [JSON.stringify(["notes"]), run.rows[0].run_id, step.rows[0].step_id],
    );

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const b = await pool.query("SELECT status, backup_artifact_id FROM backups WHERE backup_id = $1", [backup.rows[0].backup_id]);
    expect(b.rowCount).toBe(1);
    expect(b.rows[0].status).toBe("succeeded");
    expect(b.rows[0].backup_artifact_id).toBeTruthy();
    const art = await pool.query("SELECT type, content_text FROM artifacts WHERE artifact_id = $1 LIMIT 1", [b.rows[0].backup_artifact_id]);
    expect(art.rowCount).toBe(1);
    expect(art.rows[0].type).toBe("backup");
    const lines = String(art.rows[0].content_text)
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const first = JSON.parse(lines[0]);
    expect(first.entityName).toBe("notes");
    expect(first.payload.title).toBeTruthy();
  });

  it("执行 space.restore（upsert）并生成 restore_report artifact", async () => {
    const seed = await pool.query(
      "INSERT INTO entity_records (tenant_id, space_id, entity_name, schema_name, schema_version, payload) VALUES ('tenant_dev','space_dev','notes','core',1,$1) RETURNING id",
      [{ title: "Restore A", content: "c1" }],
    );
    const recordId = seed.rows[0].id as string;

    const contentText =
      JSON.stringify({
        entityName: "notes",
        id: recordId,
        payload: { title: "Restore A2", content: "c2" },
      }) + "\n";
    const art = await pool.query(
      `
        INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source)
        VALUES ('tenant_dev','space_dev','backup','jsonl','application/x-ndjson; charset=utf-8',$1,$2,$3)
        RETURNING artifact_id
      `,
      [Buffer.byteLength(contentText, "utf8"), contentText, { spaceId: "space_dev" }],
    );
    const backupArtifactId = art.rows[0].artifact_id as string;

    const job = await pool.query("INSERT INTO jobs (tenant_id, job_type, status) VALUES ('tenant_dev', 'space.restore', 'queued') RETURNING job_id");
    const run = await pool.query(
      "INSERT INTO runs (tenant_id, status, tool_ref, input_digest, idempotency_key) VALUES ('tenant_dev', 'created', 'space.restore:space_dev', $1, NULL) RETURNING run_id",
      [{ spaceId: "space_dev" }],
    );
    const step = await pool.query(
      "INSERT INTO steps (run_id, seq, status, tool_ref, input) VALUES ($1, 1, 'pending', NULL, $2) RETURNING step_id",
      [
        run.rows[0].run_id,
        {
          kind: "space.restore",
          spaceId: "space_dev",
          schemaName: "core",
          backupArtifactId,
          conflictStrategy: "upsert",
          fieldRules: { read: { allow: ["*"], deny: [] }, write: { allow: ["*"], deny: [] } },
          tenantId: "tenant_dev",
          subjectId: "admin",
          traceId: "t-space-restore",
        },
      ],
    );
    await pool.query("UPDATE jobs SET run_id = $1 WHERE job_id = $2", [run.rows[0].run_id, job.rows[0].job_id]);

    await processStep({ pool, masterKey, jobId: job.rows[0].job_id, runId: run.rows[0].run_id, stepId: step.rows[0].step_id });

    const report = await pool.query(
      "SELECT content_text FROM artifacts WHERE tenant_id = 'tenant_dev' AND run_id = $1 AND type = 'restore_report' ORDER BY created_at DESC LIMIT 1",
      [run.rows[0].run_id],
    );
    expect(report.rowCount).toBe(1);
    const parsed = JSON.parse(String(report.rows[0].content_text));
    expect(parsed.acceptedCount).toBeGreaterThan(0);

    const updated = await pool.query("SELECT payload->>'title' AS title FROM entity_records WHERE id = $1 LIMIT 1", [recordId]);
    expect(updated.rowCount).toBe(1);
    expect(updated.rows[0].title).toBe("Restore A2");
  });

  it("subscription runner：poll 产出 ingress event 并推进 watermark", async () => {
    const subRes = await pool.query(
      `
        INSERT INTO subscriptions (tenant_id, space_id, provider, status, poll_interval_sec, watermark)
        VALUES ('tenant_dev', NULL, 'mock', 'enabled', 3600, '{"seq":0}'::jsonb)
        RETURNING subscription_id
      `,
    );
    const subscriptionId = subRes.rows[0].subscription_id as string;

    const before = await pool.query("SELECT watermark FROM subscriptions WHERE subscription_id = $1", [subscriptionId]);
    expect(before.rows[0].watermark?.seq).toBe(0);

    const r1 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBe(false);

    const after = await pool.query("SELECT watermark, last_run_at FROM subscriptions WHERE subscription_id = $1", [subscriptionId]);
    expect(after.rows[0].watermark?.seq).toBe(1);
    expect(after.rows[0].last_run_at).toBeTruthy();

    const ev = await pool.query(
      "SELECT 1 FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'mock' AND workspace_id = $1 LIMIT 1",
      [`subscription:${subscriptionId}`],
    );
    expect(ev.rowCount).toBe(1);

    const run = await pool.query(
      "SELECT status, event_count, trace_id FROM subscription_runs WHERE subscription_id = $1 ORDER BY started_at DESC LIMIT 1",
      [subscriptionId],
    );
    expect(run.rows[0].status).toBe("succeeded");
    expect(Number(run.rows[0].event_count)).toBe(1);

    const a = await pool.query(
      "SELECT 1 FROM audit_events WHERE resource_type = 'subscription' AND action = 'poll' AND trace_id = $1 LIMIT 1",
      [run.rows[0].trace_id],
    );
    expect(a.rowCount).toBe(1);

    const r2 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBe(true);
  });

  it("imap subscription：mock 拉取写入 ingress event 并推进 watermark", async () => {
    const host = "imap.example.com";
    const instance = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.imap','enabled',$2::jsonb)
        RETURNING id
      `,
      [`imap-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const connectorInstanceId = instance.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,'{}'::jsonb)
        RETURNING id
      `,
      [connectorInstanceId],
    );
    const secretId = secret.rows[0].id as string;

    await pool.query(
      `
        INSERT INTO imap_connector_configs (connector_instance_id, tenant_id, host, port, use_tls, username, password_secret_id, mailbox)
        VALUES ($1,'tenant_dev',$2,993,true,'u',$3,'INBOX')
      `,
      [connectorInstanceId, host, secretId],
    );

    const subRes = await pool.query(
      `
        INSERT INTO subscriptions (tenant_id, space_id, provider, connector_instance_id, status, poll_interval_sec, watermark)
        VALUES ('tenant_dev', 'space_dev', 'imap', $1, 'enabled', 3600, '{"uidNext":1}'::jsonb)
        RETURNING subscription_id
      `,
      [connectorInstanceId],
    );
    const subscriptionId = subRes.rows[0].subscription_id as string;

    const r1 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBe(false);
    expect((r1 as any).watermarkAfter.uidNext).toBe(2);

    const ev = await pool.query(
      "SELECT provider, workspace_id FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'imap' AND workspace_id = $1 LIMIT 1",
      [`imap:${connectorInstanceId}:INBOX`],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("exchange subscription：graph delta 拉取写入 ingress event 并推进 watermark", async () => {
    const host = "graph.microsoft.com";
    const inst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.exchange','enabled',$2::jsonb)
        RETURNING id
      `,
      [`ex-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const connectorInstanceId = inst.rows[0].id as string;

    const grantInst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled','{}'::jsonb)
        RETURNING id
      `,
      [`oauth-${crypto.randomUUID()}`],
    );
    const grantConnectorInstanceId = grantInst.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,$2::jsonb)
        RETURNING id
      `,
      [grantConnectorInstanceId, JSON.stringify(encryptJson(process.env.API_MASTER_KEY ?? "dev-master-key-change-me", { access_token: "t", token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token", client_id: "c" }))],
    );
    const secretId = secret.rows[0].id as string;

    const grant = await pool.query(
      `
        INSERT INTO oauth_grants (tenant_id, space_id, connector_instance_id, provider, secret_record_id, scopes, token_expires_at, status)
        VALUES ('tenant_dev','space_dev',$1,'exchange',$2,NULL,NULL,'active')
        RETURNING grant_id
      `,
      [grantConnectorInstanceId, secretId],
    );
    const oauthGrantId = grant.rows[0].grant_id as string;

    await pool.query(
      `
        INSERT INTO exchange_connector_configs (connector_instance_id, tenant_id, oauth_grant_id, mailbox)
        VALUES ($1,'tenant_dev',$2,'user@example.com')
      `,
      [connectorInstanceId, oauthGrantId],
    );

    const subRes = await pool.query(
      `
        INSERT INTO subscriptions (tenant_id, space_id, provider, connector_instance_id, status, poll_interval_sec, watermark)
        VALUES ('tenant_dev', 'space_dev', 'exchange', $1, 'enabled', 3600, '{"seq":0}'::jsonb)
        RETURNING subscription_id
      `,
      [connectorInstanceId],
    );
    const subscriptionId = subRes.rows[0].subscription_id as string;

    const origFetch = (globalThis as any).fetch;
    const fetchStub = vi.fn(async () => {
      const payload = {
        value: [{ id: "m-1", receivedDateTime: new Date().toISOString(), from: { emailAddress: { address: "a@b.com" } }, toRecipients: [{ emailAddress: { address: "c@d.com" } }], subject: "s", hasAttachments: false, bodyPreview: "p" }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?d=1",
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub as any);

    const r1 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    vi.stubGlobal("fetch", origFetch as any);
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBe(false);
    expect((r1 as any).watermarkAfter.deltaLink).toBeTruthy();

    const ev = await pool.query(
      "SELECT provider, workspace_id FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'exchange' AND workspace_id = $1 LIMIT 1",
      [`exchange:${connectorInstanceId}:user@example.com`],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("exchange subscription：分页 nextLink→deltaLink 且幂等去重", async () => {
    const host = "graph.microsoft.com";
    const inst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.exchange','enabled',$2::jsonb)
        RETURNING id
      `,
      [`ex2-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const connectorInstanceId = inst.rows[0].id as string;

    const grantInst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled','{}'::jsonb)
        RETURNING id
      `,
      [`oauth2-${crypto.randomUUID()}`],
    );
    const grantConnectorInstanceId = grantInst.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,$2::jsonb)
        RETURNING id
      `,
      [
        grantConnectorInstanceId,
        JSON.stringify(encryptJson(process.env.API_MASTER_KEY ?? "dev-master-key-change-me", { access_token: "t", token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token", client_id: "c" })),
      ],
    );
    const secretId = secret.rows[0].id as string;

    const grant = await pool.query(
      `
        INSERT INTO oauth_grants (tenant_id, space_id, connector_instance_id, provider, secret_record_id, scopes, token_expires_at, status)
        VALUES ('tenant_dev','space_dev',$1,'exchange',$2,NULL,NULL,'active')
        RETURNING grant_id
      `,
      [grantConnectorInstanceId, secretId],
    );
    const oauthGrantId = grant.rows[0].grant_id as string;

    await pool.query(
      `
        INSERT INTO exchange_connector_configs (connector_instance_id, tenant_id, oauth_grant_id, mailbox)
        VALUES ($1,'tenant_dev',$2,'user2@example.com')
      `,
      [connectorInstanceId, oauthGrantId],
    );

    const subRes = await pool.query(
      `
        INSERT INTO subscriptions (tenant_id, space_id, provider, connector_instance_id, status, poll_interval_sec, watermark)
        VALUES ('tenant_dev', 'space_dev', 'exchange', $1, 'enabled', 1, '{"seq":0}'::jsonb)
        RETURNING subscription_id
      `,
      [connectorInstanceId],
    );
    const subscriptionId = subRes.rows[0].subscription_id as string;

    const origFetch = (globalThis as any).fetch;
    let n = 0;
    const fetchStub = vi.fn(async (url: any) => {
      n++;
      if (n === 1) {
        const payload = {
          value: [{ id: "m-1" }, { id: "m-2" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
        };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).includes("page2")) {
        const payload = { value: [{ id: "m-3" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?d=2" };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected_url");
    });
    vi.stubGlobal("fetch", fetchStub as any);

    const r1 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    vi.stubGlobal("fetch", origFetch as any);
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBe(false);
    expect((r1 as any).watermarkAfter.deltaLink).toBeTruthy();

    const ev1 = await pool.query("SELECT COUNT(*)::int AS c FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'exchange' AND workspace_id = $1", [
      `exchange:${connectorInstanceId}:user2@example.com`,
    ]);
    expect(ev1.rows[0].c).toBe(3);

    await pool.query("UPDATE subscriptions SET last_run_at = now() - interval '10 seconds', updated_at = now() WHERE subscription_id = $1", [subscriptionId]);

    const origFetch2 = (globalThis as any).fetch;
    const fetchStub2 = vi.fn(async () => {
      const payload = { value: [{ id: "m-1" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?d=3" };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub2 as any);

    const r2 = await processSubscriptionPoll({ pool, subscriptionId, masterKey });
    vi.stubGlobal("fetch", origFetch2 as any);
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBe(false);

    const ev2 = await pool.query("SELECT COUNT(*)::int AS c FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'exchange' AND workspace_id = $1", [
      `exchange:${connectorInstanceId}:user2@example.com`,
    ]);
    expect(ev2.rows[0].c).toBe(3);
  });

  it("exchange subscription：429 尊重 retry-after 并写 backoff", async () => {
    const host = "graph.microsoft.com";
    const inst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.exchange','enabled',$2::jsonb)
        RETURNING id
      `,
      [`ex3-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const connectorInstanceId = inst.rows[0].id as string;

    const grantInst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled','{}'::jsonb)
        RETURNING id
      `,
      [`oauth3-${crypto.randomUUID()}`],
    );
    const grantConnectorInstanceId = grantInst.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,$2::jsonb)
        RETURNING id
      `,
      [
        grantConnectorInstanceId,
        JSON.stringify(encryptJson(process.env.API_MASTER_KEY ?? "dev-master-key-change-me", { access_token: "t", token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token", client_id: "c" })),
      ],
    );
    const secretId = secret.rows[0].id as string;

    const grant = await pool.query(
      `
        INSERT INTO oauth_grants (tenant_id, space_id, connector_instance_id, provider, secret_record_id, scopes, token_expires_at, status)
        VALUES ('tenant_dev','space_dev',$1,'exchange',$2,NULL,NULL,'active')
        RETURNING grant_id
      `,
      [grantConnectorInstanceId, secretId],
    );
    const oauthGrantId = grant.rows[0].grant_id as string;

    await pool.query(
      `
        INSERT INTO exchange_connector_configs (connector_instance_id, tenant_id, oauth_grant_id, mailbox)
        VALUES ($1,'tenant_dev',$2,'user3@example.com')
      `,
      [connectorInstanceId, oauthGrantId],
    );

    const subRes = await pool.query(
      `
        INSERT INTO subscriptions (tenant_id, space_id, provider, connector_instance_id, status, poll_interval_sec, watermark)
        VALUES ('tenant_dev', 'space_dev', 'exchange', $1, 'enabled', 1, NULL)
        RETURNING subscription_id
      `,
      [connectorInstanceId],
    );
    const subscriptionId = subRes.rows[0].subscription_id as string;

    const origFetch = (globalThis as any).fetch;
    const fetchStub = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
    vi.stubGlobal("fetch", fetchStub as any);

    await expect(processSubscriptionPoll({ pool, subscriptionId, masterKey })).rejects.toBeTruthy();
    vi.stubGlobal("fetch", origFetch as any);

    const run = await pool.query("SELECT backoff_ms, error_category FROM subscription_runs WHERE subscription_id = $1 ORDER BY started_at DESC LIMIT 1", [subscriptionId]);
    expect(run.rowCount).toBe(1);
    expect(run.rows[0].error_category).toBe("rate_limited");
    expect(Number(run.rows[0].backoff_ms)).toBeGreaterThanOrEqual(2000);

    const sub = await pool.query("SELECT next_run_at FROM subscriptions WHERE subscription_id = $1 LIMIT 1", [subscriptionId]);
    expect(sub.rowCount).toBe(1);
    expect(sub.rows[0].next_run_at).toBeTruthy();
  });

  it("notification delivery：email outbox queued→sent（含审计）", async () => {
    const host = "smtp.example.com";
    await pool.query("DELETE FROM notification_outbox WHERE tenant_id = 'tenant_dev' AND channel = 'email'");
    await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.smtp','enabled',$2::jsonb)
        RETURNING id
      `,
      [`smtp-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const inst = await pool.query("SELECT id FROM connector_instances WHERE tenant_id='tenant_dev' AND type_name='mail.smtp' ORDER BY created_at DESC LIMIT 1");
    const connectorInstanceId = inst.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,'{}'::jsonb)
        RETURNING id
      `,
      [connectorInstanceId],
    );
    const secretId = secret.rows[0].id as string;

    await pool.query(
      `
        INSERT INTO smtp_connector_configs (connector_instance_id, tenant_id, host, port, use_tls, username, password_secret_id, from_address)
        VALUES ($1,'tenant_dev',$2,587,true,'u',$3,'noreply@example.com')
      `,
      [connectorInstanceId, host, secretId],
    );

    const templateId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO notification_templates (template_id, tenant_id, scope_type, scope_id, key, channel, status)
        VALUES ($1,'tenant_dev','space','space_dev',$2,'email','active')
      `,
      [templateId, `t-${crypto.randomUUID()}`],
    );

    const out = await pool.query(
      `
        INSERT INTO notification_outbox (
          tenant_id, space_id, channel, recipient_ref,
          template_id, template_version, connector_instance_id, locale,
          params_digest, content_ciphertext, status, delivery_status
        )
        VALUES (
          'tenant_dev','space_dev','email','user:ok',
          $2, 1, $1, 'zh-CN',
          '{}'::jsonb, '{"alg":"aes-256-gcm"}'::jsonb, 'queued', 'queued'
        )
        RETURNING outbox_id
      `,
      [connectorInstanceId, templateId],
    );
    const outboxId = out.rows[0].outbox_id as string;

    await tickEmailDeliveries({ pool, limit: 10 });
    const r = await pool.query("SELECT delivery_status FROM notification_outbox WHERE outbox_id = $1", [outboxId]);
    expect(r.rows[0].delivery_status).toBe("sent");

    const a = await pool.query("SELECT 1 FROM audit_events WHERE resource_type = 'notification' AND action = 'delivery.sent' LIMIT 1");
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it("notification delivery：失败重试→deadletter", async () => {
    const host = "smtp.example.com";
    const inst = await pool.query(
      `
        INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
        VALUES ('tenant_dev','space','space_dev',$1,'mail.smtp','enabled',$2::jsonb)
        RETURNING id
      `,
      [`smtp2-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: [host] })],
    );
    const connectorInstanceId = inst.rows[0].id as string;

    const secret = await pool.query(
      `
        INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, encrypted_payload)
        VALUES ('tenant_dev','space','space_dev',$1,'active',1,'{}'::jsonb)
        RETURNING id
      `,
      [connectorInstanceId],
    );
    const secretId = secret.rows[0].id as string;

    await pool.query(
      `
        INSERT INTO smtp_connector_configs (connector_instance_id, tenant_id, host, port, use_tls, username, password_secret_id, from_address)
        VALUES ($1,'tenant_dev',$2,587,true,'u',$3,'noreply@example.com')
      `,
      [connectorInstanceId, host, secretId],
    );

    const templateId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO notification_templates (template_id, tenant_id, scope_type, scope_id, key, channel, status)
        VALUES ($1,'tenant_dev','space','space_dev',$2,'email','active')
      `,
      [templateId, `t-${crypto.randomUUID()}`],
    );

    const out = await pool.query(
      `
        INSERT INTO notification_outbox (
          tenant_id, space_id, channel, recipient_ref,
          template_id, template_version, connector_instance_id, locale,
          params_digest, content_ciphertext, status, delivery_status
        )
        VALUES (
          'tenant_dev','space_dev','email','user:fail',
          $2, 1, $1, 'zh-CN',
          '{}'::jsonb, '{"alg":"aes-256-gcm"}'::jsonb, 'queued', 'queued'
        )
        RETURNING outbox_id
      `,
      [connectorInstanceId, templateId],
    );
    const outboxId = out.rows[0].outbox_id as string;

    await tickEmailDeliveries({ pool, limit: 10 });
    await pool.query("UPDATE notification_outbox SET next_attempt_at = now() - interval '1 second' WHERE outbox_id = $1", [outboxId]);
    await tickEmailDeliveries({ pool, limit: 10 });
    await pool.query("UPDATE notification_outbox SET next_attempt_at = now() - interval '1 second' WHERE outbox_id = $1", [outboxId]);
    await tickEmailDeliveries({ pool, limit: 10 });
    const r = await pool.query("SELECT delivery_status, attempt_count FROM notification_outbox WHERE outbox_id = $1", [outboxId]);
    expect(r.rows[0].delivery_status).toBe("deadletter");
    expect(Number(r.rows[0].attempt_count)).toBe(3);
  });

  it("webhook delivery：async queued→succeeded（含审计）", async () => {
    const prevApiBase = process.env.WORKER_API_BASE;
    const prevAuthnMode = process.env.AUTHN_MODE;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/orchestrator/turn") {
        let buf = "";
        req.on("data", (c) => (buf += String(c)));
        req.on("end", () => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ replyText: "ok" }));
        });
        return;
      }
      res.statusCode = 404;
      res.end("not_found");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });
    process.env.WORKER_API_BASE = `http://127.0.0.1:${port}`;
    process.env.AUTHN_MODE = "dev";

    try {
      await pool.query("DELETE FROM channel_ingress_events WHERE tenant_id = 'tenant_dev' AND provider = 'wh' AND workspace_id = 'ws1'");
      await pool.query(
        `
          INSERT INTO channel_webhook_configs (tenant_id, provider, workspace_id, space_id, secret_env_key, tolerance_sec, delivery_mode, max_attempts, backoff_ms_base)
          VALUES ('tenant_dev', 'wh', 'ws1', 'space_dev', 'DUMMY', 300, 'async', 3, 0)
          ON CONFLICT (tenant_id, provider, workspace_id) DO UPDATE SET delivery_mode = EXCLUDED.delivery_mode, max_attempts = EXCLUDED.max_attempts, backoff_ms_base = EXCLUDED.backoff_ms_base
        `,
      );
      await pool.query(
        `
          INSERT INTO channel_accounts (tenant_id, provider, workspace_id, channel_user_id, subject_id, space_id, status)
          VALUES ('tenant_dev','wh','ws1','u1','admin','space_dev','active')
          ON CONFLICT DO NOTHING
        `,
      );
      const eventId = `e-${crypto.randomUUID()}`;
      const nonce = `n-${crypto.randomUUID()}`;
      const ins = await pool.query(
        `
          INSERT INTO channel_ingress_events (tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, status)
          VALUES ('tenant_dev','wh','ws1',$1,$2,'bd', $3::jsonb, 'r1', 't1', 'queued')
          RETURNING id
        `,
        [eventId, nonce, { channelUserId: "u1", channelChatId: "c1", text: "ok" }],
      );
      const id = ins.rows[0].id as string;
      await tickWebhookDeliveries({ pool, limit: 10 });
      const ev = await pool.query("SELECT status, response_status_code FROM channel_ingress_events WHERE id = $1", [id]);
      expect(ev.rows[0].status).toBe("succeeded");
      expect(ev.rows[0].response_status_code).toBe(200);
      const outbox = await pool.query(
        "SELECT 1 FROM channel_outbox_messages WHERE tenant_id = 'tenant_dev' AND provider = 'wh' AND workspace_id = 'ws1' AND channel_chat_id = 'c1' AND status = 'queued' LIMIT 1",
      );
      expect(outbox.rowCount).toBeGreaterThan(0);
      const a = await pool.query("SELECT 1 FROM audit_events WHERE resource_type = 'channel' AND action = 'webhook.delivered' LIMIT 1");
      expect(a.rowCount).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevApiBase == null) delete process.env.WORKER_API_BASE;
      else process.env.WORKER_API_BASE = prevApiBase;
      if (prevAuthnMode == null) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevAuthnMode;
    }
  });

  it("audit siem：webhook 增量投递与 cursor/outbox 生效", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += String(c)));
      req.on("end", () => {
        received.push(buf);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    try {
      await pool.query("UPDATE audit_siem_destinations SET enabled = false WHERE tenant_id = 'tenant_dev'");
      const inst = await pool.query(
        `
          INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
          VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled',$2::jsonb)
          RETURNING id
        `,
        [`siem-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: ["127.0.0.1"] })],
      );
      const masterKey = process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
      const secret = await pool.query(
        `
          INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, enc_format, encrypted_payload)
          VALUES ('tenant_dev','space','space_dev',$1,'active',1,'legacy.a256gcm',$2::jsonb)
          RETURNING id
        `,
        [inst.rows[0].id, JSON.stringify(encryptJson(masterKey, { webhookUrl: `http://127.0.0.1:${port}/` }))],
      );
      const dest = await pool.query(
        `
          INSERT INTO audit_siem_destinations (tenant_id, name, enabled, secret_id, batch_size, timeout_ms)
          VALUES ('tenant_dev',$1,true,$2,100,2000)
          RETURNING id
        `,
        [`dest-${crypto.randomUUID()}`, secret.rows[0].id],
      );

      await pool.query(
        `
          INSERT INTO audit_siem_cursors (tenant_id, destination_id, last_ts, last_event_id)
          VALUES ('tenant_dev',$1,now(),'00000000-0000-0000-0000-000000000000')
          ON CONFLICT (tenant_id, destination_id) DO UPDATE
          SET last_ts = EXCLUDED.last_ts,
              last_event_id = EXCLUDED.last_event_id,
              updated_at = now()
        `,
        [dest.rows[0].id],
      );

      await pool.query(
        `
          INSERT INTO audit_events (tenant_id, resource_type, action, result, trace_id)
          VALUES ('tenant_dev','audit','t1','success',$1),
                 ('tenant_dev','audit','t2','success',$2),
                 ('tenant_dev','audit','t3','success',$3)
        `,
        [`t-siem-1-${crypto.randomUUID()}`, `t-siem-2-${crypto.randomUUID()}`, `t-siem-3-${crypto.randomUUID()}`],
      );

      await tickAuditSiemWebhookExport({ pool, masterKey, destinationsLimit: 20 });

      const outbox = await pool.query("SELECT 1 FROM audit_siem_outbox WHERE tenant_id = 'tenant_dev' AND destination_id = $1 LIMIT 1", [dest.rows[0].id]);
      expect(outbox.rowCount).toBe(0);
      const cursor = await pool.query("SELECT last_ts, last_event_id FROM audit_siem_cursors WHERE tenant_id = 'tenant_dev' AND destination_id = $1 LIMIT 1", [dest.rows[0].id]);
      expect(cursor.rowCount).toBe(1);
      expect(cursor.rows[0].last_ts).toBeTruthy();
      expect(cursor.rows[0].last_event_id).toBeTruthy();

      expect(received.length).toBeGreaterThan(0);
      const lines = received.join("").split("\n").map((x) => x.trim()).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const first = JSON.parse(lines[0]);
      expect(first.tenantId).toBe("tenant_dev");
      expect(first.eventId).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("audit siem：egress denied 将阻断投递并进入 DLQ", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += String(c)));
      req.on("end", () => {
        received.push(buf);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    try {
      await pool.query("UPDATE audit_siem_destinations SET enabled = false WHERE tenant_id = 'tenant_dev'");
      const inst = await pool.query(
        `
          INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
          VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled',$2::jsonb)
          RETURNING id
        `,
        [`siem-deny-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: ["example.com"] })],
      );
      const masterKey = process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
      const secret = await pool.query(
        `
          INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, enc_format, encrypted_payload)
          VALUES ('tenant_dev','space','space_dev',$1,'active',1,'legacy.a256gcm',$2::jsonb)
          RETURNING id
        `,
        [inst.rows[0].id, JSON.stringify(encryptJson(masterKey, { webhookUrl: `http://127.0.0.1:${port}/` }))],
      );
      const dest = await pool.query(
        `
          INSERT INTO audit_siem_destinations (tenant_id, name, enabled, secret_id, batch_size, timeout_ms)
          VALUES ('tenant_dev',$1,true,$2,100,2000)
          RETURNING id
        `,
        [`dest-deny-${crypto.randomUUID()}`, secret.rows[0].id],
      );

      await pool.query(
        `
          INSERT INTO audit_siem_cursors (tenant_id, destination_id, last_ts, last_event_id)
          VALUES ('tenant_dev',$1,now(),'00000000-0000-0000-0000-000000000000')
          ON CONFLICT (tenant_id, destination_id) DO UPDATE
          SET last_ts = EXCLUDED.last_ts,
              last_event_id = EXCLUDED.last_event_id,
              updated_at = now()
        `,
        [dest.rows[0].id],
      );

      await pool.query(
        `
          INSERT INTO audit_events (tenant_id, resource_type, action, result, trace_id)
          VALUES ('tenant_dev','audit','t1','success',$1)
        `,
        [`t-siem-deny-${crypto.randomUUID()}`],
      );

      await tickAuditSiemWebhookExport({ pool, masterKey, destinationsLimit: 20 });

      expect(received.length).toBe(0);
      const dlq = await pool.query("SELECT 1 FROM audit_siem_dlq WHERE tenant_id = 'tenant_dev' AND destination_id = $1 LIMIT 1", [dest.rows[0].id]);
      expect(dlq.rowCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it("webhook delivery：失败重试→deadletter", async () => {
    const prevApiBase = process.env.WORKER_API_BASE;
    const prevAuthnMode = process.env.AUTHN_MODE;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/orchestrator/turn") {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ errorCode: "INTERNAL_ERROR", message: { "zh-CN": "failed" } }));
        return;
      }
      res.statusCode = 404;
      res.end("not_found");
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });
    process.env.WORKER_API_BASE = `http://127.0.0.1:${port}`;
    process.env.AUTHN_MODE = "dev";

    await pool.query(
      `
        INSERT INTO channel_webhook_configs (tenant_id, provider, workspace_id, space_id, secret_env_key, tolerance_sec, delivery_mode, max_attempts, backoff_ms_base)
        VALUES ('tenant_dev', 'wh', 'ws2', 'space_dev', 'DUMMY', 300, 'async', 2, 0)
        ON CONFLICT (tenant_id, provider, workspace_id) DO UPDATE SET delivery_mode = EXCLUDED.delivery_mode, max_attempts = EXCLUDED.max_attempts, backoff_ms_base = EXCLUDED.backoff_ms_base
      `,
    );
    await pool.query(
      `
        INSERT INTO channel_accounts (tenant_id, provider, workspace_id, channel_user_id, subject_id, space_id, status)
        VALUES ('tenant_dev','wh','ws2','u1','admin','space_dev','active')
        ON CONFLICT DO NOTHING
      `,
    );
    const eventId = `e-${crypto.randomUUID()}`;
    const nonce = `n-${crypto.randomUUID()}`;
    const ins = await pool.query(
      `
        INSERT INTO channel_ingress_events (tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, status)
        VALUES ('tenant_dev','wh','ws2',$1,$2,'bd', $3::jsonb, 'r2', 't2', 'queued')
        RETURNING id
      `,
      [eventId, nonce, { channelUserId: "u1", channelChatId: "c2", text: "ok" }],
    );
    const id = ins.rows[0].id as string;
    try {
      await tickWebhookDeliveries({ pool, limit: 10 });
      await pool.query("UPDATE channel_ingress_events SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [id]);
      await tickWebhookDeliveries({ pool, limit: 10 });
      const ev = await pool.query("SELECT status, attempt_count FROM channel_ingress_events WHERE id = $1", [id]);
      expect(ev.rows[0].status).toBe("deadletter");
      expect(Number(ev.rows[0].attempt_count)).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prevApiBase == null) delete process.env.WORKER_API_BASE;
      else process.env.WORKER_API_BASE = prevApiBase;
      if (prevAuthnMode == null) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevAuthnMode;
    }
  });

  it("channel outbox：async queued→delivered（webhook）", async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += String(c)));
      req.on("end", () => {
        received.push(buf);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    try {
      const inst = await pool.query(
        `
          INSERT INTO connector_instances (tenant_id, scope_type, scope_id, name, type_name, status, egress_policy)
          VALUES ('tenant_dev','space','space_dev',$1,'generic.api_key','enabled',$2::jsonb)
          RETURNING id
        `,
        [`wh-${crypto.randomUUID()}`, JSON.stringify({ allowedDomains: ["127.0.0.1"] })],
      );
      const masterKey = process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
      const secret = await pool.query(
        `
          INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, enc_format, encrypted_payload)
          VALUES ('tenant_dev','space','space_dev',$1,'active',1,'legacy.a256gcm',$2::jsonb)
          RETURNING id
        `,
        [inst.rows[0].id, JSON.stringify(encryptJson(masterKey, { webhookUrl: `http://127.0.0.1:${port}/` }))],
      );

      await pool.query(
        `
          INSERT INTO channel_webhook_configs (tenant_id, provider, workspace_id, space_id, secret_env_key, secret_id, tolerance_sec, delivery_mode, max_attempts, backoff_ms_base)
          VALUES ('tenant_dev', 'wh', 'ws3', 'space_dev', 'DUMMY', $1, 300, 'async', 3, 0)
          ON CONFLICT (tenant_id, provider, workspace_id) DO UPDATE
          SET secret_id = EXCLUDED.secret_id,
              delivery_mode = EXCLUDED.delivery_mode,
              max_attempts = EXCLUDED.max_attempts,
              backoff_ms_base = EXCLUDED.backoff_ms_base
        `,
        [secret.rows[0].id],
      );

      const out = await pool.query(
        `
          INSERT INTO channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, to_user_id, request_id, trace_id, status, message_json)
          VALUES ('tenant_dev','wh','ws3','c3',NULL,'r3','t3','queued',$1::jsonb)
          RETURNING id
        `,
        [JSON.stringify({ text: "hello" })],
      );
      const outboxId = out.rows[0].id as string;

      await tickChannelOutboxDeliveries({ pool, masterKey, limit: 10 });

      const row = await pool.query("SELECT status, delivered_at FROM channel_outbox_messages WHERE id = $1 LIMIT 1", [outboxId]);
      expect(row.rows[0].status).toBe("delivered");
      expect(row.rows[0].delivered_at).toBeTruthy();
      expect(received.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
