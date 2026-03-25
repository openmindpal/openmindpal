import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { redactValue } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { createDocument, createIndexJob, createRetrievalLog, getRetrievalLog, resolveEvidenceRef, searchChunksHybrid } from "../modules/knowledge/repo";

export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.post("/knowledge/documents", async (req) => {
    setAuditContext(req, { resourceType: "knowledge", action: "ingest" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "ingest" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        title: z.string().min(1),
        sourceType: z.string().min(1),
        tags: z.any().optional(),
        contentText: z.string().min(1),
        visibility: z.enum(["space", "subject"]).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { title: body.title, sourceType: body.sourceType, contentLen: body.contentText.length };

    const doc = await createDocument({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      title: body.title,
      sourceType: body.sourceType,
      tags: body.tags,
      contentText: body.contentText,
      visibility: body.visibility ?? "space",
      ownerSubjectId: body.visibility === "subject" ? subject.subjectId : null,
    });
    const indexJob = await createIndexJob({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, documentId: doc.id, documentVersion: doc.version });

    await app.queue.add("knowledge.index", { kind: "knowledge.index", indexJobId: indexJob.id }, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });

    req.ctx.audit!.outputDigest = { documentId: doc.id, version: doc.version, indexJobId: indexJob.id };
    return { documentId: doc.id, version: doc.version, indexJobId: indexJob.id };
  });

  app.post("/knowledge/search", async (req) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

      const body = z
        .object({
          query: z.string().min(1),
          limit: z.number().int().positive().max(20).optional(),
        })
        .parse(req.body);

      const limit = body.limit ?? 5;
      req.ctx.audit!.inputDigest = { queryLen: body.query.length, limit };

      const out = await searchChunksHybrid({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, query: body.query, limit });
      const rankPolicy = out.rankPolicy;
      const evidenceBase = out.hits.map((h: any) => {
        const snippetRaw = String(h.snippet ?? "");
        const clipped = snippetRaw.slice(0, 280);
        const redacted = redactValue(clipped);
        return {
          sourceRef: { documentId: h.document_id, version: h.document_version, chunkId: h.id },
          snippet: String(redacted.value ?? ""),
          location: { chunkIndex: h.chunk_index, startOffset: h.start_offset, endOffset: h.end_offset },
          snippetDigest: { len: snippetRaw.length, sha256_8: crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8) },
          rankReason: h.rank_reason ?? { kind: rankPolicy },
        };
      });

      const retrievalLogId = await createRetrievalLog({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        queryDigest: { queryLen: body.query.length, rankPolicy },
        filtersDigest: { spaceId: subject.spaceId, source: "knowledge.search.http" },
        candidateCount: out.stageStats.merged.candidateCount,
        citedRefs: evidenceBase.map((e) => e.sourceRef),
        rankPolicy,
        stageStats: out.stageStats,
        rankedEvidenceRefs: evidenceBase.map((e) => ({ sourceRef: e.sourceRef, rankReason: e.rankReason, snippetDigest: e.snippetDigest, location: e.location })),
        returnedCount: evidenceBase.length,
      });

      const evidence = evidenceBase.map((e) => ({ ...e, retrievalLogId }));
      req.ctx.audit!.outputDigest = {
        retrievalLogId,
        candidateCount: out.stageStats.merged.candidateCount,
        returnedCount: evidenceBase.length,
        citedRefs: evidenceBase.map((e) => e.sourceRef),
        rankPolicy,
        stageStats: out.stageStats,
      };
      app.metrics.observeKnowledgeSearch({ result: "ok", latencyMs: Number(out.stageStats?.latencyMs ?? Date.now() - startedAt) });
      return { retrievalLogId, evidence, candidateCount: out.stageStats.merged.candidateCount, returnedCount: evidenceBase.length, rankSummary: { rankPolicy, stageStats: out.stageStats } };
    } catch (e: any) {
      app.metrics.observeKnowledgeSearch({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt });
      throw e;
    }
  });

  async function assertEvidenceBelongsToRetrievalLog(params: { tenantId: string; spaceId: string; retrievalLogId: string; sourceRef: any }) {
    const log = await getRetrievalLog({ pool: app.db, tenantId: params.tenantId, spaceId: params.spaceId, id: params.retrievalLogId });
    if (!log) throw Errors.badRequest("retrievalLogId 不存在");
    const check = (x: any) =>
      x &&
      typeof x === "object" &&
      String((x as any).documentId ?? "") === String(params.sourceRef?.documentId ?? "") &&
      Number((x as any).version ?? NaN) === Number(params.sourceRef?.version ?? NaN) &&
      String((x as any).chunkId ?? "") === String(params.sourceRef?.chunkId ?? "");
    const cited = Array.isArray(log.citedRefs) ? log.citedRefs.some(check) : false;
    const ranked = Array.isArray(log.rankedEvidenceRefs) ? log.rankedEvidenceRefs.some((e: any) => check(e?.sourceRef)) : false;
    if (!cited && !ranked) throw Errors.notFound("Evidence 不存在或无权限");
  }

  app.post("/knowledge/evidence/resolve", async (req, reply) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
      const body = z
        .object({
          sourceRef: z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() }),
          retrievalLogId: z.string().uuid().optional(),
          maxSnippetLen: z.number().int().positive().max(2000).optional(),
        })
        .parse(req.body);

      if (body.retrievalLogId) {
        try {
          await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef: body.sourceRef });
        } catch (e: any) {
          app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
          return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
        }
      }

      const r = await resolveEvidenceRef({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        sourceRef: body.sourceRef,
      });
      if (!r) {
        app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
      }

      const snippetRaw = String(r.snippet ?? "");
      const clipped = snippetRaw.slice(0, body.maxSnippetLen ?? 600);
      const redacted = redactValue(clipped);
      const snippet = String(redacted.value ?? "");
      const digest8 = crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8);

      req.ctx.audit!.outputDigest = {
        sourceRef: body.sourceRef,
        snippetLen: snippetRaw.length,
        snippetDigest8: digest8,
        documentId: String(r.document_id),
        version: Number(r.document_version),
        chunkIndex: Number(r.chunk_index),
      };
      app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
      return {
        evidence: {
          sourceRef: body.sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
        },
      };
    } catch (e: any) {
      app.metrics.observeKnowledgeEvidenceResolve({ result: e?.errorCode ? (String(e.errorCode).includes("DENIED") || String(e.errorCode).includes("FORBIDDEN") ? "denied" : "error") : "error", latencyMs: Date.now() - startedAt });
      throw e;
    }
  });

  app.post("/knowledge/evidence/resolveBatch", async (req) => {
    const startedAt = Date.now();
    setAuditContext(req, { resourceType: "knowledge", action: "search" });
    const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z
      .object({
        retrievalLogId: z.string().uuid().optional(),
        sourceRefs: z.array(z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() })).min(1).max(20),
        maxSnippetLen: z.number().int().positive().max(2000).optional(),
      })
      .parse(req.body);

    const out: any[] = [];
    for (const sourceRef of body.sourceRefs) {
      if (body.retrievalLogId) {
        try {
          await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef });
        } catch {
          out.push({ ok: false, status: 404, sourceRef });
          continue;
        }
      }
      const r = await resolveEvidenceRef({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        sourceRef,
      });
      if (!r) {
        out.push({ ok: false, status: 404, sourceRef });
        continue;
      }
      const snippetRaw = String(r.snippet ?? "");
      const clipped = snippetRaw.slice(0, body.maxSnippetLen ?? 600);
      const redacted = redactValue(clipped);
      const snippet = String(redacted.value ?? "");
      const digest8 = crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8);
      out.push({
        ok: true,
        evidence: {
          sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
        },
      });
    }

    req.ctx.audit!.outputDigest = { count: out.length, retrievalLogId: body.retrievalLogId ?? null };
    app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
    return { items: out };
  });
};
