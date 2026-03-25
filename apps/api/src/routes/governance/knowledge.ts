import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex } from "../../lib/digest";
import { getEmbeddingJob, getIngestJob, getIndexJob, getRetrievalLog, listEmbeddingJobs, listIngestJobs, listIndexJobs, listRetrievalLogs, searchChunksHybrid } from "../../skills/knowledge-rag/modules/repo";
import { getEvidenceRetentionPolicy, upsertEvidenceRetentionPolicy } from "../../skills/knowledge-rag/modules/evidenceGovernanceRepo";
import { activateRetrievalStrategy, createRetrievalStrategy, createStrategyEvalRun, getLatestStrategyEvalSummary, getRetrievalStrategy, getStrategyEvalRun, listRetrievalStrategies, listStrategyEvalRuns, setStrategyEvalRunFinished } from "../../skills/knowledge-rag/modules/strategyRepo";
import { createRetrievalEvalRun, createRetrievalEvalSet, getRetrievalEvalRun, getRetrievalEvalSet, listRetrievalEvalRuns, listRetrievalEvalSets, setRetrievalEvalRunFinished } from "../../skills/knowledge-rag/modules/qualityRepo";

export const governanceKnowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/knowledge/retrieval-logs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        rankPolicy: z.string().min(1).optional(),
        degraded: z.coerce.boolean().optional(),
        runId: z.string().uuid().optional(),
        source: z.string().min(1).optional(),
      })
      .parse(req.query);
    const rows = await listRetrievalLogs({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
      rankPolicy: q.rankPolicy,
      degraded: q.degraded,
      runId: q.runId,
      source: q.source,
    });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0 };
    return { logs: rows };
  });

  app.get("/governance/knowledge/retrieval-logs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "RetrievalLog 不存在", "en-US": "RetrievalLog not found" }, traceId: req.ctx.traceId });
    req.ctx.audit!.outputDigest = { retrievalLogId: row.id, candidateCount: row.candidateCount, returnedCount: row.returnedCount };
    return { log: row };
  });

  app.get("/governance/knowledge/evidence-retention-policy", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const policy = await getEvidenceRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
    req.ctx.audit!.outputDigest = { allowSnippet: policy.allowSnippet, retentionDays: policy.retentionDays, maxSnippetLen: policy.maxSnippetLen };
    return { policy };
  });

  app.put("/governance/knowledge/evidence-retention-policy", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        allowSnippet: z.boolean(),
        retentionDays: z.number().int().positive().max(3650),
        maxSnippetLen: z.number().int().positive().max(2000),
      })
      .parse(req.body);
    const row = await upsertEvidenceRetentionPolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      allowSnippet: body.allowSnippet,
      retentionDays: body.retentionDays,
      maxSnippetLen: body.maxSnippetLen,
    });
    req.ctx.audit!.outputDigest = { ok: true, allowSnippet: Boolean((row as any).allow_snippet), retentionDays: Number((row as any).retention_days), maxSnippetLen: Number((row as any).max_snippet_len) };
    return { ok: true };
  });

  app.get("/governance/knowledge/retrieval-strategies", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const rows = await listRetrievalStrategies({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { strategies: rows };
  });

  app.post("/governance/knowledge/retrieval-strategies", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        name: z.string().min(2).max(64),
        config: z.any().optional(),
      })
      .parse(req.body);
    const config =
      body.config && typeof body.config === "object"
        ? body.config
        : {
            kind: "knowledge.retrievalStrategy.v1",
            rankPolicy: "hybrid_minhash_rerank_v2",
            weights: { lex: 1.2, vec: 1, recency: 0.05, metaBoost: 0.08 },
            limits: { lexicalLimit: 80, embedLimit: 120, metaLimit: 40 },
            gate: { minHitAtK: 0.5, minMrrAtK: 0.2 },
          };
    const row = await createRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: body.name, config, createdBySubjectId: subject.subjectId ?? null });
    req.ctx.audit!.outputDigest = { id: row.id, name: row.name, version: row.version };
    return { strategy: row };
  });

  app.post("/governance/knowledge/retrieval-strategies/:id/activate", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const strategy = await getRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!strategy) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Strategy 不存在", "en-US": "Strategy not found" }, traceId: req.ctx.traceId });
    const gate = (strategy.config as any)?.gate ?? { minHitAtK: 0.5, minMrrAtK: 0.2, minAvgReturnedCount: 1, maxEvalAgeDays: 7 };
    const needsEval = Boolean(gate && (gate.minHitAtK !== undefined || gate.minMrrAtK !== undefined || gate.minAvgReturnedCount !== undefined));
    if (needsEval) {
      const latest = await getLatestStrategyEvalSummary({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, strategyId: strategy.id });
      if (!latest) return reply.status(403).send({ errorCode: "GATE_MISSING_EVAL", message: { "zh-CN": "缺少最近评测结果，禁止激活", "en-US": "Missing eval results" }, traceId: req.ctx.traceId });
      const metrics = latest.metrics ?? null;
      const m = metrics && typeof metrics === "object" ? (metrics as any)[String(strategy.id)] ?? null : null;
      const hitAtK = Number(m?.hitAtK ?? 0);
      const mrrAtK = Number(m?.mrrAtK ?? 0);
      const avgReturnedCount = Number(m?.avgReturnedCount ?? 0);
      const maxAgeDays = gate.maxEvalAgeDays !== undefined ? Number(gate.maxEvalAgeDays) : 7;
      const createdAtMs = Date.parse(String(latest.createdAt ?? ""));
      const ageDays = Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) / (24 * 60 * 60 * 1000) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(maxAgeDays) && ageDays > maxAgeDays) {
        return reply.status(403).send({
          errorCode: "GATE_MISSING_EVAL",
          message: { "zh-CN": "最近评测结果已过期，禁止激活", "en-US": "Eval results too old" },
          traceId: req.ctx.traceId,
          details: { evalCreatedAt: latest.createdAt, ageDays, maxAgeDays },
        });
      }
      if (
        (gate.minHitAtK !== undefined && hitAtK < Number(gate.minHitAtK)) ||
        (gate.minMrrAtK !== undefined && mrrAtK < Number(gate.minMrrAtK)) ||
        (gate.minAvgReturnedCount !== undefined && avgReturnedCount < Number(gate.minAvgReturnedCount))
      ) {
        return reply.status(403).send({
          errorCode: "GATE_FAILED",
          message: { "zh-CN": "评测指标回归，禁止激活", "en-US": "Gate failed" },
          traceId: req.ctx.traceId,
          details: {
            hitAtK,
            mrrAtK,
            avgReturnedCount,
            minHitAtK: gate.minHitAtK ?? null,
            minMrrAtK: gate.minMrrAtK ?? null,
            minAvgReturnedCount: gate.minAvgReturnedCount ?? null,
            evalCreatedAt: latest.createdAt,
          },
        });
      }
    }
    await activateRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: strategy.id });
    req.ctx.audit!.outputDigest = { ok: true, id: strategy.id, name: strategy.name, version: strategy.version };
    return { ok: true };
  });

  app.post("/governance/knowledge/retrieval-strategy-eval-runs", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        evalSetId: z.string().uuid(),
        strategyIds: z.array(z.string().uuid()).min(1).max(5),
      })
      .parse(req.body);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.evalSetId });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });

    const run = await createStrategyEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: set.id, strategyIds: body.strategyIds, createdBySubjectId: subject.subjectId ?? null });

    const strategies: any[] = [];
    for (const id of body.strategyIds) {
      const s = await getRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id });
      if (s) strategies.push(s);
    }
    if (strategies.length === 0) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "没有可用 strategy", "en-US": "No strategies" }, traceId: req.ctx.traceId });

    const queries = Array.isArray(set.queries) ? (set.queries as any[]) : [];
    const results: any[] = [];
    const failures: any[] = [];
    const metricsByStrategy: Record<string, any> = {};
    try {
      for (const s of strategies) {
        let total = 0;
        let hit = 0;
        let mrrSum = 0;
        let candidateSum = 0;
        let returnedSum = 0;
        for (const q of queries) {
          const queryText = String(q?.query ?? "");
          const k = Number(q?.k ?? 5);
          const expected = Array.isArray(q?.expectedDocumentIds) ? (q.expectedDocumentIds as string[]).map(String) : [];
          if (!queryText.trim() || expected.length === 0) continue;
          total++;
          const out = await searchChunksHybrid({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            query: queryText,
            limit: Math.max(1, Math.min(50, k)),
            strategyRef: `${s.name}@${s.version}`,
            strategyConfig: s.config,
          });
          const docs = (out.hits as any[]).map((h) => String(h.document_id ?? "")).filter(Boolean);
          const firstIdx = docs.findIndex((d) => expected.includes(d));
          const ok = firstIdx >= 0;
          if (ok) {
            hit++;
            mrrSum += 1 / (1 + firstIdx);
          }
          candidateSum += Number(out.stageStats?.merged?.candidateCount ?? 0);
          returnedSum += docs.length;
          results.push({
            strategyId: s.id,
            strategyRef: `${s.name}@${s.version}`,
            queryDigest8: sha256Hex(queryText).slice(0, 8),
            k,
            hit: ok,
            firstRank: ok ? firstIdx + 1 : null,
            candidateCount: Number(out.stageStats?.merged?.candidateCount ?? 0),
            returnedCount: docs.length,
            rankPolicy: out.rankPolicy,
          });
        }
        metricsByStrategy[s.id] = {
          strategyRef: `${s.name}@${s.version}`,
          total,
          hitAtK: total ? hit / total : 0,
          mrrAtK: total ? mrrSum / total : 0,
          avgCandidateCount: total ? candidateSum / total : 0,
          avgReturnedCount: total ? returnedSum / total : 0,
        };
      }
      const done = await setStrategyEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: run.id, status: "succeeded", metrics: metricsByStrategy, results, failures });
      return { run: done ?? run };
    } catch (e: any) {
      failures.push({ kind: "error", message: String(e?.message ?? e) });
      const done = await setStrategyEvalRunFinished({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: run.id, status: "failed", metrics: metricsByStrategy, results, failures });
      return reply.status(500).send({ run: done ?? run });
    }
  });

  app.get("/governance/knowledge/retrieval-strategy-eval-runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        evalSetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const rows = await listStrategyEvalRuns({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: q.evalSetId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { runs: rows };
  });

  app.get("/governance/knowledge/retrieval-strategy-eval-runs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await getStrategyEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });
    return { run };
  });

  app.get("/governance/knowledge/ingest-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listIngestJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/ingest-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getIngestJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "IngestJob 不存在", "en-US": "IngestJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.get("/governance/knowledge/embedding-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listEmbeddingJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/embedding-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getEmbeddingJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EmbeddingJob 不存在", "en-US": "EmbeddingJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.get("/governance/knowledge/index-jobs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const rows = await listIndexJobs({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    req.ctx.audit!.outputDigest = { count: rows.length, limit: q.limit ?? 50, offset: q.offset ?? 0, status: q.status ?? null };
    return { jobs: rows };
  });

  app.get("/governance/knowledge/index-jobs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await getIndexJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!row) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "IndexJob 不存在", "en-US": "IndexJob not found" }, traceId: req.ctx.traceId });
    return { job: row };
  });

  app.post("/governance/knowledge/quality/eval-sets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        queries: z
          .array(
            z.object({
              query: z.string().min(1).max(2000),
              expectedDocumentIds: z.array(z.string().uuid()).min(1).max(50),
              k: z.number().int().positive().max(50).optional(),
            }),
          )
          .min(1)
          .max(2000),
      })
      .parse(req.body);
    const set = await createRetrievalEvalSet({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      name: body.name,
      description: body.description ?? null,
      queries: body.queries,
      createdBySubjectId: subject.subjectId,
    });
    req.ctx.audit!.outputDigest = { evalSetId: set.id, queryCount: Array.isArray(body.queries) ? body.queries.length : 0 };
    return { set };
  });

  app.get("/governance/knowledge/quality/eval-sets", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query);
    const sets = await listRetrievalEvalSets({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { sets };
  });

  app.get("/governance/knowledge/quality/eval-sets/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });
    return { set };
  });

  app.post("/governance/knowledge/quality/eval-sets/:id/runs", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const set = await getRetrievalEvalSet({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!set) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalSet 不存在", "en-US": "EvalSet not found" }, traceId: req.ctx.traceId });

    const run = await createRetrievalEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: set.id });

    const queries = Array.isArray(set.queries) ? (set.queries as any[]) : [];
    const results: any[] = [];
    const failures: any[] = [];
    let total = 0;
    let hit = 0;
    let mrrSum = 0;
    let candidateSum = 0;
    let returnedSum = 0;
    try {
      for (const q of queries) {
        const queryText = String(q?.query ?? "");
        const k = Number(q?.k ?? 5);
        const expected = Array.isArray(q?.expectedDocumentIds) ? (q.expectedDocumentIds as string[]).map(String) : [];
        if (!queryText.trim() || expected.length === 0) continue;
        total++;
        const out = await searchChunksHybrid({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, query: queryText, limit: Math.max(1, Math.min(50, k)) });
        const docs = (out.hits as any[]).map((h) => String(h.document_id ?? "")).filter(Boolean);
        const firstIdx = docs.findIndex((d) => expected.includes(d));
        const ok = firstIdx >= 0;
        if (ok) {
          hit++;
          mrrSum += 1 / (1 + firstIdx);
        }
        candidateSum += Number(out.stageStats?.merged?.candidateCount ?? 0);
        returnedSum += docs.length;
        results.push({
          queryDigest8: sha256Hex(queryText).slice(0, 8),
          queryLen: queryText.length,
          k,
          expectedCount: expected.length,
          returnedCount: docs.length,
          candidateCount: Number(out.stageStats?.merged?.candidateCount ?? 0),
          hit: ok,
          firstRank: ok ? firstIdx + 1 : null,
          rankPolicy: out.rankPolicy,
        });
      }
      const metrics = {
        total,
        hitAtK: total ? hit / total : 0,
        mrrAtK: total ? mrrSum / total : 0,
        avgCandidateCount: total ? candidateSum / total : 0,
        avgReturnedCount: total ? returnedSum / total : 0,
      };
      const done = await setRetrievalEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.id,
        status: "succeeded",
        metrics,
        results,
        failures,
      });
      return { run: done ?? run };
    } catch (e: any) {
      failures.push({ kind: "error", message: String(e?.message ?? e) });
      const done = await setRetrievalEvalRunFinished({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.id,
        status: "failed",
        metrics: { total, hitAtK: total ? hit / total : 0, mrrAtK: total ? mrrSum / total : 0 },
        results,
        failures,
      });
      return reply.status(500).send({ run: done ?? run });
    }
  });

  app.get("/governance/knowledge/quality/runs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z
      .object({
        evalSetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const runs = await listRetrievalEvalRuns({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, evalSetId: q.evalSetId, limit: q.limit ?? 50, offset: q.offset ?? 0 });
    return { runs };
  });

  app.get("/governance/knowledge/quality/runs/:id", async (req, reply) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await getRetrievalEvalRun({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: params.id });
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "EvalRun 不存在", "en-US": "EvalRun not found" }, traceId: req.ctx.traceId });
    return { run };
  });
};
