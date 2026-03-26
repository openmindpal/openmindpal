import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { processKnowledgeIndexJob } from "../../knowledge/processor";
import { processKnowledgeEmbeddingJob } from "../../knowledge/embedding";
import { processKnowledgeIngestJob } from "../../knowledge/ingest";

export const knowledgeRagWorker: WorkerSkillContribution = {
  skillName: "knowledge.rag",
  jobs: [
    {
      kind: "knowledge.index",
      process: async ({ pool, data }) => {
        await processKnowledgeIndexJob({ pool, indexJobId: data.indexJobId });
      },
    },
    {
      kind: "knowledge.embed",
      process: async ({ pool, data }) => {
        await processKnowledgeEmbeddingJob({ pool, embeddingJobId: data.embeddingJobId });
      },
    },
    {
      kind: "knowledge.ingest",
      process: async ({ pool, data, queue }) => {
        const out = await processKnowledgeIngestJob({ pool, ingestJobId: data.ingestJobId });
        if (out?.indexJobId) {
          await queue.add("knowledge.index", { kind: "knowledge.index", indexJobId: out.indexJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
        }
      },
    },
  ],
  tickers: [
    {
      name: "knowledge.ingest.scan",
      intervalMs: 10_000,
      tick: async ({ pool, queue }) => {
        const pendingRes = await pool.query(
          "SELECT count(*)::int AS c FROM knowledge_ingest_jobs WHERE status IN ('queued','running')",
        );
        const pending = Number(pendingRes.rows[0]?.c ?? 0);
        if (pending > 200) return;
        const res = await pool.query(
          `
            WITH candidates AS (
              SELECT e.tenant_id, e.space_id, e.provider, e.workspace_id, e.event_id, e.id AS source_event_pk
              FROM channel_ingress_events e
              WHERE e.created_at > now() - interval '7 days'
                AND e.status = 'received'
                AND e.provider IN ('imap','exchange','mock')
                AND e.space_id IS NOT NULL
              ORDER BY e.created_at DESC
              LIMIT 50
            )
            INSERT INTO knowledge_ingest_jobs (tenant_id, space_id, provider, workspace_id, event_id, source_event_pk, status)
            SELECT c.tenant_id, c.space_id, c.provider, c.workspace_id, c.event_id, c.source_event_pk, 'queued'
            FROM candidates c
            ON CONFLICT (tenant_id, provider, workspace_id, event_id)
            DO NOTHING
            RETURNING id
          `,
          [],
        );
        for (const r of res.rows as any[]) {
          const ingestJobId = String(r.id ?? "");
          if (!ingestJobId) continue;
          await queue.add("knowledge.ingest", { kind: "knowledge.ingest", ingestJobId }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });
        }
      },
    },
  ],
};
