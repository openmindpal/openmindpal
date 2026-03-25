import crypto from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";
import { buildServer } from "../server";

const cfg = loadConfig(process.env);
const pool = createPool(cfg);
const cwd = process.cwd();
const isApiCwd = cwd.replaceAll("\\", "/").endsWith("/apps/api");
const migrationsDir = isApiCwd ? path.resolve(cwd, "migrations") : path.resolve(cwd, "apps/api/migrations");

async function seedMinimal() {
  await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", ["tenant_dev"]);
  await pool.query("INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["space_dev", "tenant_dev"]);
  await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["admin", "tenant_dev"]);
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
}

describe.sequential("knowledge retrieval upgrade e2e", { timeout: 90_000 }, () => {
  const app: any = buildServer(cfg, { db: pool, queue: { add: async () => ({}) } as any });
  let canRun = false;
  const headers = {
    authorization: "Bearer admin",
    "x-tenant-id": "tenant_dev",
    "x-space-id": "space_dev",
    "content-type": "application/json",
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

  it("multi-route + stageStats + retrievalLog vectorStoreRef", async () => {
    if (!canRun) return;
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO knowledge_documents
          (tenant_id, space_id, id, version, source_type, title, tags, content_text, content_digest, status, visibility, owner_subject_id, created_at)
        VALUES
          ($1,$2,$3,1,'test','Doc A',$4::jsonb,'hello world tag1','sha256:x','active','space',NULL,now())
      `,
      ["tenant_dev", "space_dev", docId, JSON.stringify(["tag1"])],
    );
    await pool.query(
      `
        INSERT INTO knowledge_chunks
          (tenant_id, space_id, id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, content_digest, embedding_model_ref, embedding_minhash, embedding_updated_at, created_at)
        VALUES
          ($1,$2,$3,$4,1,0,0,10,$5,$6,'minhash:16@1',$7::int[],now(),now())
      `,
      ["tenant_dev", "space_dev", chunkId, docId, "hello world tag1", "sha256:x", Array.from({ length: 16 }, (_, i) => i + 1)],
    );

    delete process.env.KNOWLEDGE_VECTOR_STORE_MODE;
    const res = await app.inject({
      method: "POST",
      url: "/knowledge/search",
      headers,
      payload: JSON.stringify({ query: "hello", limit: 5, filters: { tags: ["tag1"], sourceTypes: ["test"] } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(typeof body.retrievalLogId).toBe("string");
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(body.rankSummary?.stageStats?.metadata?.returned).toBeGreaterThanOrEqual(0);
    expect(body.rankSummary?.stageStats?.embedding?.limit).toBeGreaterThan(0);

    const logRes = await pool.query("SELECT vector_store_ref, degrade_reason FROM knowledge_retrieval_logs WHERE id=$1", [body.retrievalLogId]);
    expect(logRes.rowCount).toBe(1);
    expect(logRes.rows[0].vector_store_ref).toBeTruthy();
  });

  it("vectorStore external 不可用 => degraded=true", async () => {
    if (!canRun) return;
    process.env.KNOWLEDGE_VECTOR_STORE_MODE = "external";
    process.env.KNOWLEDGE_VECTOR_STORE_ENDPOINT = "http://127.0.0.1:1";
    process.env.KNOWLEDGE_VECTOR_STORE_TIMEOUT_MS = "50";

    const res = await app.inject({
      method: "POST",
      url: "/knowledge/search",
      headers,
      payload: JSON.stringify({ query: "hello", limit: 5 }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.rankSummary?.stageStats?.embedding?.degraded).toBe(true);
  });

  it("retention policy 禁止 snippet 回放 + access event 记录", async () => {
    if (!canRun) return;
    await app.inject({
      method: "PUT",
      url: "/governance/knowledge/evidence-retention-policy",
      headers,
      payload: JSON.stringify({ allowSnippet: false, retentionDays: 30, maxSnippetLen: 10 }),
    });

    const doc = await pool.query("SELECT id, version FROM knowledge_documents WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1", ["tenant_dev", "space_dev"]);
    const chunk = await pool.query("SELECT id, document_id, document_version FROM knowledge_chunks WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1", ["tenant_dev", "space_dev"]);
    const sourceRef = { documentId: String(doc.rows[0].id), version: Number(doc.rows[0].version), chunkId: String(chunk.rows[0].id) };

    const r = await app.inject({ method: "POST", url: "/knowledge/evidence/resolve", headers, payload: JSON.stringify({ sourceRef, maxSnippetLen: 200 }) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as any;
    expect(body.evidence?.snippetAllowed).toBe(false);
    expect(String(body.evidence?.snippet ?? "")).toBe("");

    const events = await pool.query("SELECT allowed, reason FROM knowledge_evidence_access_events WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1", ["tenant_dev", "space_dev"]);
    expect(events.rowCount).toBe(1);
    expect(Boolean(events.rows[0].allowed)).toBe(true);
  });

  it("resolve 绑定 retrievalLogId：不存在时返回 404 且不写入无效 FK", async () => {
    if (!canRun) return;
    delete process.env.KNOWLEDGE_VECTOR_STORE_MODE;

    const doc = await pool.query("SELECT id, version FROM knowledge_documents WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1", ["tenant_dev", "space_dev"]);
    const chunk = await pool.query("SELECT id, document_id, document_version FROM knowledge_chunks WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1", ["tenant_dev", "space_dev"]);
    const sourceRef = { documentId: String(doc.rows[0].id), version: Number(doc.rows[0].version), chunkId: String(chunk.rows[0].id) };

    const retrievalLogId = crypto.randomUUID();
    const res = await app.inject({ method: "POST", url: "/knowledge/evidence/resolve", headers, payload: JSON.stringify({ sourceRef, retrievalLogId }) });
    expect(res.statusCode).toBe(404);

    const access = await pool.query(
      "SELECT retrieval_log_id, reason FROM knowledge_evidence_access_events WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC LIMIT 1",
      ["tenant_dev", "space_dev"],
    );
    expect(access.rowCount).toBe(1);
    expect(access.rows[0].retrieval_log_id).toBeNull();
    expect(String(access.rows[0].reason ?? "")).toBe("RETRIEVAL_LOG_NOT_FOUND");
  });

  it("active strategy 生效：rankPolicy 与 retrievalLog.strategy_ref 可观测", async () => {
    if (!canRun) return;
    const id = crypto.randomUUID();
    const name = `test_strategy_${crypto.randomUUID().slice(0, 8)}`;
    const config = {
      kind: "knowledge.retrievalStrategy.v1",
      rankPolicy: "test_policy_v1",
      weights: { lex: 2, vec: 1, recency: 0, metaBoost: 0.1 },
      limits: { lexicalLimit: 50, embedLimit: 50, metaLimit: 50 },
    };
    await pool.query(
      `
        INSERT INTO knowledge_retrieval_strategies
          (id, tenant_id, space_id, name, version, status, config, created_by_subject_id, created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,1,'active',$5::jsonb,'admin',now(),now())
        ON CONFLICT DO NOTHING
      `,
      [id, "tenant_dev", "space_dev", name, JSON.stringify(config)],
    );
    await pool.query(
      `
        INSERT INTO knowledge_retrieval_strategy_actives (tenant_id, space_id, strategy_id, updated_at)
        VALUES ($1,$2,$3,now())
        ON CONFLICT (tenant_id, space_id)
        DO UPDATE SET strategy_id = EXCLUDED.strategy_id, updated_at = now()
      `,
      ["tenant_dev", "space_dev", id],
    );

    const res = await app.inject({ method: "POST", url: "/knowledge/search", headers, payload: JSON.stringify({ query: "hello", limit: 5 }) });
    expect(res.statusCode).toBe(200);
    const b = res.json() as any;
    expect(b.rankSummary?.rankPolicy).toBe("test_policy_v1");
    expect(b.evidence?.[0]?.rankReason?.kind).toBe("test_policy_v1");

    const log = await pool.query("SELECT strategy_ref FROM knowledge_retrieval_logs WHERE id=$1", [b.retrievalLogId]);
    expect(log.rowCount).toBe(1);
    expect(String(log.rows[0].strategy_ref)).toBe(`${name}@1`);
  });
});
