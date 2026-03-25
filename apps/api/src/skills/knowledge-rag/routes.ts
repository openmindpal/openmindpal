import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { redactValue } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { createDocument, createIndexJob, createRetrievalLog, getRetrievalLog, resolveEvidenceRef, resolveEvidenceRefByChunkId, searchChunksHybrid } from "./modules/repo";
import { getEvidenceRetentionPolicy, insertEvidenceAccessEvent } from "./modules/evidenceGovernanceRepo";
import { getActiveRetrievalStrategy } from "./modules/strategyRepo";

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
          filters: z
            .object({
              documentIds: z.array(z.string().uuid()).max(200).optional(),
              tags: z.array(z.string().min(1)).max(20).optional(),
              sourceTypes: z.array(z.string().min(1)).max(20).optional(),
            })
            .optional(),
        })
        .parse(req.body);

      const limit = body.limit ?? 5;
      req.ctx.audit!.inputDigest = { queryLen: body.query.length, limit };

      const activeStrategy = await getActiveRetrievalStrategy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
      const strategyRef = activeStrategy ? `${activeStrategy.name}@${activeStrategy.version}` : null;

      const out = await searchChunksHybrid({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        query: body.query,
        limit,
        documentIds: body.filters?.documentIds,
        tags: body.filters?.tags,
        sourceTypes: body.filters?.sourceTypes,
        strategyRef,
        strategyConfig: activeStrategy?.config ?? null,
      });
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
        filtersDigest: { spaceId: subject.spaceId, source: "knowledge.search.http", documentIds: body.filters?.documentIds ?? null, tags: body.filters?.tags ?? null, sourceTypes: body.filters?.sourceTypes ?? null },
        candidateCount: out.stageStats.merged.candidateCount,
        citedRefs: evidenceBase.map((e) => e.sourceRef),
        rankPolicy,
        strategyRef: (out as any).strategyRef ?? strategyRef,
        vectorStoreRef: (out as any).vectorStoreRef ?? null,
        stageStats: out.stageStats,
        rankedEvidenceRefs: evidenceBase.map((e) => ({ sourceRef: e.sourceRef, rankReason: e.rankReason, snippetDigest: e.snippetDigest, location: e.location })),
        returnedCount: evidenceBase.length,
        degraded: Boolean((out as any).degraded ?? false),
        degradeReason: (out as any).degradeReason ?? null,
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

  async function assertEvidenceBelongsToRetrievalLog(params: { tenantId: string; spaceId: string; retrievalLogId: string; sourceRef: any; log?: any }) {
    const log = params.log ?? (await getRetrievalLog({ pool: app.db, tenantId: params.tenantId, spaceId: params.spaceId, id: params.retrievalLogId }));
    if (!log) throw Errors.notFound("retrievalLogId 不存在");
    const check = (x: any) =>
      x &&
      typeof x === "object" &&
      String((x as any).documentId ?? "") === String(params.sourceRef?.documentId ?? "") &&
      Number((x as any).version ?? NaN) === Number(params.sourceRef?.version ?? NaN) &&
      String((x as any).chunkId ?? "") === String(params.sourceRef?.chunkId ?? "");
    const cited = Array.isArray(log.citedRefs) ? log.citedRefs.some(check) : false;
    const ranked = Array.isArray(log.rankedEvidenceRefs) ? log.rankedEvidenceRefs.some((e: any) => check(e?.sourceRef)) : false;
    if (!cited && !ranked) throw Errors.notFound("Evidence 不存在或无权限");
    return log;
  }

  app.post("/knowledge/evidence/resolve", async (req, reply) => {
    const startedAt = Date.now();
    try {
      setAuditContext(req, { resourceType: "knowledge", action: "search" });
      const decision = await requirePermission({ req, resourceType: "knowledge", action: "search" });
      req.ctx.audit!.policyDecision = decision;

      const subject = requireSubject(req);
      if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
      const retention = await getEvidenceRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
      const body = z
        .object({
          sourceRef: z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() }),
          retrievalLogId: z.string().uuid().optional(),
          maxSnippetLen: z.number().int().positive().max(2000).optional(),
        })
        .parse(req.body);

      let log: any = null;
      if (body.retrievalLogId) {
        const boundLog = await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.retrievalLogId });
        if (!boundLog) {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: null,
            documentId: body.sourceRef.documentId,
            documentVersion: body.sourceRef.version,
            chunkId: body.sourceRef.chunkId,
            allowed: false,
            reason: "RETRIEVAL_LOG_NOT_FOUND",
          });
          app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
          return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
        }
        try {
          log = await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef: body.sourceRef, log: boundLog });
        } catch (e: any) {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: body.retrievalLogId,
            documentId: body.sourceRef.documentId,
            documentVersion: body.sourceRef.version,
            chunkId: body.sourceRef.chunkId,
            allowed: false,
            reason: e?.errorCode ? String(e.errorCode) : "NOT_ALLOWED",
          });
          app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
          return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
        }
      }

      const r = body.retrievalLogId
        ? await resolveEvidenceRef({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            sourceRef: body.sourceRef,
          })
        : await resolveEvidenceRefByChunkId({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            chunkId: body.sourceRef.chunkId,
          });
      if (!r) {
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: body.retrievalLogId ?? null,
          documentId: body.sourceRef.documentId,
          documentVersion: body.sourceRef.version,
          chunkId: body.sourceRef.chunkId,
          allowed: false,
          reason: "NOT_FOUND",
        });
        app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Evidence 不存在或无权限", "en-US": "Evidence not found or not allowed" }, traceId: req.ctx.traceId });
      }

      const snippetRaw = String(r.snippet ?? "");
      const createdAtMs = log?.createdAt ? Date.parse(String(log.createdAt)) : NaN;
      const ageDays = Number.isFinite(createdAtMs) ? Math.floor(Math.max(0, Date.now() - createdAtMs) / (24 * 60 * 60 * 1000)) : 0;
      const snippetAllowed = Boolean(retention.allowSnippet) && (!body.retrievalLogId || ageDays <= retention.retentionDays);
      const maxSnippetLen = Math.min(body.maxSnippetLen ?? 600, retention.maxSnippetLen);
      const clipped = snippetAllowed ? snippetRaw.slice(0, maxSnippetLen) : "";
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
      await insertEvidenceAccessEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        retrievalLogId: body.retrievalLogId ?? null,
        documentId: body.sourceRef.documentId,
        documentVersion: body.sourceRef.version,
        chunkId: body.sourceRef.chunkId,
        allowed: true,
        reason: snippetAllowed ? null : "snippet_blocked",
      });
      app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
      return {
        evidence: {
          sourceRef: body.sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
          snippetAllowed,
          policyRef: { strategyRef: log?.strategyRef ?? null, rankPolicy: log?.rankPolicy ?? null, vectorStoreRef: log?.vectorStoreRef ?? null, retrievalLogId: body.retrievalLogId ?? null },
          accessScope: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId ?? null },
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
    const retention = await getEvidenceRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId });
    const body = z
      .object({
        retrievalLogId: z.string().uuid().optional(),
        sourceRefs: z.array(z.object({ documentId: z.string().uuid(), version: z.number().int().positive(), chunkId: z.string().uuid() })).min(1).max(20),
        maxSnippetLen: z.number().int().positive().max(2000).optional(),
      })
      .parse(req.body);

    const out: any[] = [];
    const log = body.retrievalLogId ? await getRetrievalLog({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, id: body.retrievalLogId }) : null;
    if (body.retrievalLogId && !log) {
      for (const sourceRef of body.sourceRefs) {
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: null,
          documentId: sourceRef.documentId,
          documentVersion: sourceRef.version,
          chunkId: sourceRef.chunkId,
          allowed: false,
          reason: "RETRIEVAL_LOG_NOT_FOUND",
        });
        out.push({ ok: false, status: 404, sourceRef });
      }
      app.metrics.observeKnowledgeEvidenceResolve({ result: "not_found", latencyMs: Date.now() - startedAt });
      return { results: out };
    }
    const createdAtMs = log?.createdAt ? Date.parse(String(log.createdAt)) : NaN;
    const ageDays = Number.isFinite(createdAtMs) ? Math.floor(Math.max(0, Date.now() - createdAtMs) / (24 * 60 * 60 * 1000)) : 0;
    const maxSnippetLen = Math.min(body.maxSnippetLen ?? 600, retention.maxSnippetLen);
    for (const sourceRef of body.sourceRefs) {
      if (body.retrievalLogId) {
        try {
          await assertEvidenceBelongsToRetrievalLog({ tenantId: subject.tenantId, spaceId: subject.spaceId, retrievalLogId: body.retrievalLogId, sourceRef, log });
        } catch {
          await insertEvidenceAccessEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            subjectId: subject.subjectId,
            retrievalLogId: body.retrievalLogId,
            documentId: sourceRef.documentId,
            documentVersion: sourceRef.version,
            chunkId: sourceRef.chunkId,
            allowed: false,
            reason: "NOT_ALLOWED",
          });
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
        await insertEvidenceAccessEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          retrievalLogId: body.retrievalLogId ?? null,
          documentId: sourceRef.documentId,
          documentVersion: sourceRef.version,
          chunkId: sourceRef.chunkId,
          allowed: false,
          reason: "NOT_FOUND",
        });
        out.push({ ok: false, status: 404, sourceRef });
        continue;
      }
      const snippetRaw = String(r.snippet ?? "");
      const snippetAllowed = Boolean(retention.allowSnippet) && (!body.retrievalLogId || ageDays <= retention.retentionDays);
      const clipped = snippetAllowed ? snippetRaw.slice(0, maxSnippetLen) : "";
      const redacted = redactValue(clipped);
      const snippet = String(redacted.value ?? "");
      const digest8 = crypto.createHash("sha256").update(snippetRaw, "utf8").digest("hex").slice(0, 8);
      await insertEvidenceAccessEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        retrievalLogId: body.retrievalLogId ?? null,
        documentId: sourceRef.documentId,
        documentVersion: sourceRef.version,
        chunkId: sourceRef.chunkId,
        allowed: true,
        reason: snippetAllowed ? null : "snippet_blocked",
      });
      out.push({
        ok: true,
        evidence: {
          sourceRef,
          retrievalLogId: body.retrievalLogId ?? null,
          document: { title: String(r.document_title ?? ""), sourceType: String(r.document_source_type ?? "") },
          location: { chunkIndex: Number(r.chunk_index), startOffset: Number(r.start_offset), endOffset: Number(r.end_offset) },
          snippet,
          snippetDigest: { len: snippetRaw.length, sha256_8: digest8 },
          snippetAllowed,
          policyRef: { strategyRef: log?.strategyRef ?? null, rankPolicy: log?.rankPolicy ?? null, vectorStoreRef: log?.vectorStoreRef ?? null, retrievalLogId: body.retrievalLogId ?? null },
          accessScope: { tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId ?? null },
        },
      });
    }

    req.ctx.audit!.outputDigest = { count: out.length, retrievalLogId: body.retrievalLogId ?? null };
    app.metrics.observeKnowledgeEvidenceResolve({ result: "ok", latencyMs: Date.now() - startedAt });
    return { items: out };
  });
};
