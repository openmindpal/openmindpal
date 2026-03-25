import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { createArtifact, getArtifact, getArtifactContent, listArtifactsByType } from "../modules/artifacts/artifactRepo";
import { consumeArtifactDownloadTokenByHash, createArtifactDownloadToken, generateDownloadToken, hashDownloadToken } from "../modules/artifacts/artifactDownloadTokenRepo";
import { defaultArtifactPolicy, getEffectiveArtifactPolicy } from "../modules/governance/artifactPolicyRepo";
import { listActiveSkillTrustedKeys } from "../modules/governance/skillRuntimeRepo";
import { inspectSkillArtifactDir, materializeSkillArtifact } from "../modules/tools/skillArtifactRegistry";
import { parseTrustedSkillPublicKeys } from "../modules/tools/skillPackage";

export const artifactRoutes: FastifyPluginAsync = async (app) => {
  function artifactSource(art: any) {
    return {
      artifactId: art.artifactId,
      type: art.type,
      format: art.format,
      runId: art.runId ?? null,
      stepId: art.stepId ?? null,
    };
  }

  app.post("/artifacts/skill-packages/upload", async (req) => {
    setAuditContext(req, { resourceType: "artifact", action: "create" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "publish" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        archiveBase64: z.string().min(40),
        archiveFormat: z.enum(["zip", "tgz"]),
      })
      .parse(req.body);

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const base64 = body.archiveBase64.trim();
    const bytes = Buffer.from(base64, "base64");
    const maxBytes = Math.max(1, Number(process.env.SKILL_REGISTRY_MAX_UPLOAD_BYTES ?? "10485760") || 10485760);
    if (bytes.byteLength <= 0) throw Errors.badRequest("空包");
    if (bytes.byteLength > maxBytes) throw Errors.badRequest("包过大");

    const artifactId = crypto.randomUUID();
    try {
      const artifactDir = await materializeSkillArtifact({ artifactId, archiveFormat: body.archiveFormat, archiveBytes: bytes });
      const activeKeys = await listActiveSkillTrustedKeys({ pool: app.db as any, tenantId: subject.tenantId });
      const keyIdToPem: Record<string, string> = {};
      for (const k of activeKeys) keyIdToPem[k.keyId] = k.publicKeyPem;
      const trustedKeys = parseTrustedSkillPublicKeys({ keyIdToPem });
      const inspected = await inspectSkillArtifactDir({ artifactDir, trustedKeys });
      const contentType = body.archiveFormat === "zip" ? "application/zip" : "application/gzip";
      const created = await createArtifact({
        pool: app.db,
        artifactId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        type: "skill_package",
        format: body.archiveFormat,
        contentType,
        contentText: base64,
        source: {
          kind: "skill_package",
          depsDigest: inspected.depsDigest,
          signatureStatus: inspected.signatureStatus,
          manifestSummary: inspected.manifestSummary,
          scanSummary: inspected.scanSummary,
        },
        createdBySubjectId: subject.subjectId,
      });
      req.ctx.audit!.inputDigest = { archiveFormat: body.archiveFormat, byteSize: bytes.byteLength };
      req.ctx.audit!.outputDigest = { artifactId: created.artifactId, depsDigest: inspected.depsDigest, signatureStatus: inspected.signatureStatus, scanSummary: inspected.scanSummary };
      return { artifactId: created.artifactId, depsDigest: inspected.depsDigest, signatureStatus: inspected.signatureStatus, scanSummary: inspected.scanSummary, manifestSummary: inspected.manifestSummary };
    } catch (e: any) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(String(e?.message ?? e));
    }
  });

  app.get("/artifacts/skill-packages", async (req) => {
    setAuditContext(req, { resourceType: "artifact", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    const items = await listArtifactsByType({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, type: "skill_package", limit: q.limit ?? 50 });
    return { items };
  });

  app.get("/artifacts/skill-packages/:artifactId", async (req, reply) => {
    const params = z.object({ artifactId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "artifact", action: "read" });
    const decision = await requirePermission({ req, resourceType: "tool", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const art = await getArtifact(app.db, subject.tenantId, params.artifactId);
    if (!art || art.type !== "skill_package") return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Skill 包不存在", "en-US": "Skill package not found" }, traceId: req.ctx.traceId });
    if (subject.spaceId && subject.spaceId !== art.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    return { item: art };
  });

  app.post("/artifacts/:artifactId/download-token", async (req) => {
    const params = z.object({ artifactId: z.string().min(3) }).parse(req.params);
    z
      .object({
        expiresInSec: z.number().int().positive().max(3600).optional(),
        maxUses: z.number().int().positive().max(10).optional(),
      })
      .parse(req.body ?? {});
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "artifact", action: "download_token" });
    const decision = await requirePermission({ req, resourceType: "artifact", action: "download" });
    req.ctx.audit!.policyDecision = decision;

    const art = await getArtifactContent(app.db, subject.tenantId, params.artifactId);
    if (!art) throw Errors.badRequest("Artifact 不存在");
    if (subject.spaceId && subject.spaceId !== art.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (art.expiresAt && new Date(art.expiresAt).getTime() <= Date.now()) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Artifact 已过期");
    }

    const effPolicy =
      (await getEffectiveArtifactPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: art.spaceId })) ??
      defaultArtifactPolicy({ tenantId: subject.tenantId, scopeType: "space", scopeId: art.spaceId });
    const expiresInSec = effPolicy.downloadTokenExpiresInSec;
    const maxUses = effPolicy.downloadTokenMaxUses;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
    const token = generateDownloadToken();
    const tokenHash = hashDownloadToken(token);
    const tokenId = crypto.randomUUID();
    await createArtifactDownloadToken({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: art.spaceId,
      artifactId: art.artifactId,
      issuedBySubjectId: subject.subjectId,
      tokenId,
      tokenHash,
      expiresAt,
      maxUses,
    });

    req.ctx.audit!.inputDigest = { artifactId: art.artifactId, expiresInSec, maxUses };
    req.ctx.audit!.outputDigest = { artifactId: art.artifactId, tokenId, expiresAt, maxUses };
    return { token, tokenId, expiresAt, downloadUrl: `/artifacts/download?token=${encodeURIComponent(token)}` };
  });

  app.get("/artifacts/download", async (req, reply) => {
    const q = z.object({ token: z.string().min(10) }).parse(req.query);
    setAuditContext(req, { resourceType: "artifact", action: "download" });

    const consumed = await consumeArtifactDownloadTokenByHash({ pool: app.db, tokenHash: hashDownloadToken(q.token) });
    if (!consumed) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.artifactTokenDenied();
    }

    const art = await getArtifactContent(app.db, consumed.tenantId, consumed.artifactId);
    if (!art || art.spaceId !== consumed.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.artifactTokenDenied();
    }
    if (art.expiresAt && new Date(art.expiresAt).getTime() <= Date.now()) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.artifactTokenDenied();
    }

    const watermarkId = consumed.tokenId;
    const src = artifactSource(art);
    req.ctx.audit!.inputDigest = { artifactId: consumed.artifactId, tokenId: consumed.tokenId };
    req.ctx.audit!.outputDigest = {
      artifactId: consumed.artifactId,
      tokenId: consumed.tokenId,
      expiresAt: consumed.expiresAt,
      maxUses: consumed.maxUses,
      usedCountAfter: consumed.usedCount,
      contentType: art.contentType,
      length: art.contentText.length,
      watermarkId,
      artifactSource: src,
    };

    const effPolicy =
      (await getEffectiveArtifactPolicy({ pool: app.db, tenantId: consumed.tenantId, spaceId: consumed.spaceId })) ??
      defaultArtifactPolicy({ tenantId: consumed.tenantId, scopeType: "space", scopeId: consumed.spaceId });
    if (effPolicy.watermarkHeadersEnabled) {
      reply.header("x-artifact-watermark-id", watermarkId);
      reply.header("x-artifact-source", JSON.stringify(src));
    }
    reply.header("content-type", art.contentType);
    return art.contentText;
  });

  app.get("/artifacts/:artifactId/download", async (req, reply) => {
    const params = z.object({ artifactId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "artifact", action: "download" });
    const decision = await requirePermission({ req, resourceType: "artifact", action: "download" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const art = await getArtifactContent(app.db, subject.tenantId, params.artifactId);
    if (!art) throw Errors.badRequest("Artifact 不存在");
    if (subject.spaceId && subject.spaceId !== art.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (art.expiresAt && new Date(art.expiresAt).getTime() <= Date.now()) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Artifact 已过期");
    }

    const watermarkId = `artifact:${art.artifactId}`;
    const src = artifactSource(art);
    req.ctx.audit!.outputDigest = { artifactId: art.artifactId, contentType: art.contentType, length: art.contentText.length, watermarkId, artifactSource: src };
    const effPolicy =
      (await getEffectiveArtifactPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: art.spaceId })) ??
      defaultArtifactPolicy({ tenantId: subject.tenantId, scopeType: "space", scopeId: art.spaceId });
    if (effPolicy.watermarkHeadersEnabled) {
      reply.header("x-artifact-watermark-id", watermarkId);
      reply.header("x-artifact-source", JSON.stringify(src));
    }
    reply.header("content-type", art.contentType);
    return art.contentText;
  });
};
