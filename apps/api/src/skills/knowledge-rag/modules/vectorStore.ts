import crypto from "node:crypto";
import type { Pool } from "pg";
import type { VectorStoreCapabilitiesV1, VectorStoreQueryResponseV1, VectorStoreRefV1 } from "@openslin/shared";

export type VectorStoreConfigV1 =
  | { mode: "fallback" }
  | { mode: "external"; endpoint: string; bearerToken: string | null; timeoutMs: number };

export type VectorStoreQueryV1 = {
  tenantId: string;
  spaceId: string;
  subjectId: string;
  embeddingModelRef: string;
  vector: number[];
  topK: number;
  filters?: { documentIds?: string[] };
};

export type VectorStore = {
  ref: VectorStoreRefV1;
  capabilities(): VectorStoreCapabilitiesV1;
  query(params: { pool: Pool; q: VectorStoreQueryV1 }): Promise<VectorStoreQueryResponseV1>;
};

function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

function stableStringify(v: any) {
  return JSON.stringify(stableStringifyValue(v));
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function resolveVectorStoreConfigFromEnv(): VectorStoreConfigV1 {
  const modeRaw = String(process.env.KNOWLEDGE_VECTOR_STORE_MODE ?? "").trim().toLowerCase();
  if (modeRaw === "external") {
    const endpoint = String(process.env.KNOWLEDGE_VECTOR_STORE_ENDPOINT ?? "").trim();
    const bearerToken = String(process.env.KNOWLEDGE_VECTOR_STORE_BEARER_TOKEN ?? "").trim() || null;
    const timeoutMsRaw = Number(process.env.KNOWLEDGE_VECTOR_STORE_TIMEOUT_MS ?? 1500);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.round(timeoutMsRaw) : 1500;
    if (!endpoint) return { mode: "fallback" };
    return { mode: "external", endpoint, bearerToken, timeoutMs };
  }
  return { mode: "fallback" };
}

export function vectorStoreRefFromConfig(cfg: VectorStoreConfigV1): VectorStoreRefV1 {
  if (cfg.mode === "external") {
    const digest8 = sha256Hex(stableStringify({ endpoint: cfg.endpoint })).slice(0, 8);
    return { mode: "external", impl: "external.http.v1", endpointDigest8: digest8 };
  }
  return { mode: "fallback", impl: "postgres.minhash.v1" };
}

export function createVectorStore(cfg: VectorStoreConfigV1): VectorStore {
  if (cfg.mode === "external") return new ExternalVectorStore(cfg);
  return new FallbackVectorStore();
}

class ExternalVectorStore implements VectorStore {
  readonly ref: VectorStoreRefV1;
  constructor(private readonly cfg: Extract<VectorStoreConfigV1, { mode: "external" }>) {
    this.ref = vectorStoreRefFromConfig(cfg);
  }
  capabilities(): VectorStoreCapabilitiesV1 {
    return { kind: "vectorStore.capabilities.v1", supportsUpsert: true, supportsDelete: true, supportsQuery: true, vectorType: "int32", distance: "overlap", maxK: 200 };
  }
  async query(params: { pool: Pool; q: VectorStoreQueryV1 }): Promise<VectorStoreQueryResponseV1> {
    const url = new URL(this.cfg.endpoint);
    url.pathname = url.pathname.replace(/\/$/, "") + "/v1/query";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(
        url.toString(),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            format: "vectorStore.query.v1",
            tenantId: params.q.tenantId,
            spaceId: params.q.spaceId,
            embeddingModelRef: params.q.embeddingModelRef,
            vector: params.q.vector,
            topK: params.q.topK,
            filters: params.q.filters ?? null,
          }),
          signal: controller.signal,
        } as any,
      );
      const text = await res.text();
      if (!res.ok) return { results: [], degraded: true, degradeReason: `vector_store_http_${res.status}` };
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        return { results: [], degraded: true, degradeReason: "vector_store_bad_json" };
      }
      const out = Array.isArray(parsed?.results) ? parsed.results : [];
      return {
        results: out
          .map((x: any) => ({ chunkId: String(x?.chunkId ?? ""), score: Number(x?.score ?? 0) }))
          .filter((x: any) => x.chunkId && Number.isFinite(x.score)),
        degraded: Boolean(parsed?.degraded ?? false),
        degradeReason: parsed?.degradeReason ? String(parsed.degradeReason) : null,
      };
    } catch (e: any) {
      return { results: [], degraded: true, degradeReason: String(e?.message ?? e ?? "vector_store_error") };
    } finally {
      clearTimeout(t);
    }
  }
}

class FallbackVectorStore implements VectorStore {
  readonly ref: VectorStoreRefV1 = vectorStoreRefFromConfig({ mode: "fallback" });
  capabilities(): VectorStoreCapabilitiesV1 {
    return { kind: "vectorStore.capabilities.v1", supportsUpsert: false, supportsDelete: false, supportsQuery: true, vectorType: "int32", distance: "overlap", maxK: 200 };
  }
  async query(params: { pool: Pool; q: VectorStoreQueryV1 }): Promise<VectorStoreQueryResponseV1> {
    const topK = Math.max(1, Math.min(200, Math.round(params.q.topK)));
    const res = await params.pool.query(
      `
        SELECT id, embedding_minhash
        FROM knowledge_chunks
        WHERE tenant_id = $1 AND space_id = $2
          AND embedding_minhash && $3::int[]
          AND EXISTS (
            SELECT 1
            FROM knowledge_documents d
            WHERE d.tenant_id = knowledge_chunks.tenant_id
              AND d.space_id = knowledge_chunks.space_id
              AND d.id = knowledge_chunks.document_id
              AND d.version = knowledge_chunks.document_version
              AND (
                d.visibility = 'space'
                OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
              )
          )
        ORDER BY embedding_updated_at DESC NULLS LAST
        LIMIT $5
      `,
      [params.q.tenantId, params.q.spaceId, params.q.vector, params.q.subjectId, Math.max(80, topK)],
    );
    const querySet = new Set(params.q.vector.map((x) => Number(x)));
    const scored = (res.rows as any[])
      .map((r) => {
        const mh = Array.isArray(r.embedding_minhash) ? (r.embedding_minhash as number[]) : [];
        let hit = 0;
        for (const v of mh) if (querySet.has(Number(v))) hit++;
        const score = params.q.vector.length ? hit / params.q.vector.length : 0;
        return { chunkId: String(r.id), score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { results: scored, degraded: false, degradeReason: null };
  }
}

