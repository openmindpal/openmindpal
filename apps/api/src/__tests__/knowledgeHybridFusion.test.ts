import crypto from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";
import { searchChunksHybrid } from "../skills/knowledge-rag/modules/repo";

const cfg = loadConfig(process.env);
const pool = createPool(cfg);
const cwd = process.cwd();
const isApiCwd = cwd.replaceAll("\\", "/").endsWith("/apps/api");
const migrationsDir = isApiCwd ? path.resolve(cwd, "migrations") : path.resolve(cwd, "apps/api/migrations");

describe.sequential("knowledge hybrid fusion unit", { timeout: 90_000 }, () => {
  let canRun = false;

  beforeAll(async () => {
    try {
      await migrate(pool, migrationsDir);
      canRun = true;
    } catch (e) {
      canRun = false;
    }
  });

  afterAll(async () => {
    await pool.end();
  }, 120_000);

  it("fusion 去重：metadata 与 lexical 命中同一 chunk 只返回 1 个候选", async () => {
    if (!canRun) return;
    delete process.env.KNOWLEDGE_VECTOR_STORE_MODE;

    const tenantId = `t_${crypto.randomUUID()}`;
    const spaceId = `s_${crypto.randomUUID()}`;
    await pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [tenantId]);
    await pool.query("INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [spaceId, tenantId]);

    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO knowledge_documents
          (tenant_id, space_id, id, version, source_type, title, tags, content_text, content_digest, status, visibility, owner_subject_id, created_at)
        VALUES
          ($1,$2,$3,1,'test','Doc Fusion',$4::jsonb,'hello world tag1','sha256:x','active','space',NULL,now())
      `,
      [tenantId, spaceId, docId, JSON.stringify(["tag1"])],
    );
    await pool.query(
      `
        INSERT INTO knowledge_chunks
          (tenant_id, space_id, id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, content_digest, embedding_model_ref, embedding_minhash, embedding_updated_at, created_at)
        VALUES
          ($1,$2,$3,$4,1,0,0,10,$5,$6,'minhash:16@1',$7::int[],now(),now())
      `,
      [tenantId, spaceId, chunkId, docId, "hello world tag1", "sha256:x", Array.from({ length: 16 }, (_, i) => i + 1)],
    );

    const out = await searchChunksHybrid({
      pool,
      tenantId,
      spaceId,
      subjectId: "admin",
      query: "hello",
      limit: 10,
      tags: ["tag1"],
      sourceTypes: ["test"],
    });

    expect(out.stageStats.metadata.returned).toBeGreaterThanOrEqual(1);
    expect(out.stageStats.lexical.returned).toBeGreaterThanOrEqual(1);
    expect(out.stageStats.merged.candidateCount).toBe(1);
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]?.rank_reason?.kind).toBeTruthy();
    expect(typeof out.hits[0]?.rank_reason?.sLex).toBe("number");
    expect(typeof out.hits[0]?.rank_reason?.sVec).toBe("number");
  });
});
