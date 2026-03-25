import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { createMediaJob } from "../modules/media/jobRepo";
import { createMediaObject, getMediaContent, getMediaObject } from "../modules/media/mediaRepo";
import { fsCompose, fsDelete, fsGet, fsPut } from "../modules/media/blobStore";
import { createUpload, getUpload, listParts, setUploadStatus, upsertPart } from "../modules/media/uploadRepo";

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  try {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
  } catch {
  }

  app.post("/media/objects", async (req) => {
    const body = z
      .object({
        spaceId: z.string().min(1).optional(),
        contentType: z.string().min(1).max(200),
        contentBase64: z.string().min(1),
        source: z.unknown().optional(),
        provenance: z.unknown().optional(),
        safetyDigest: z.unknown().optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "media", action: "upload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "upload" });
    const subject = req.ctx.subject!;

    const spaceId = body.spaceId ?? subject.spaceId;
    if (!spaceId) throw Errors.badRequest("缺少 spaceId");
    if (subject.spaceId && subject.spaceId !== spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.contentBase64, "base64");
    } catch {
      throw Errors.badRequest("contentBase64 无效");
    }
    if (!bytes.length) throw Errors.badRequest("内容为空");
    if (bytes.length > 5 * 1024 * 1024) throw Errors.badRequest("文件过大");

    const storageKey = `objects/${subject.tenantId}/${crypto.randomUUID()}`;
    const stored = await fsPut({ rootDir: app.cfg.media.fsRootDir, storageKey, bytes });
    const obj = await createMediaObject({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId,
      contentType: body.contentType,
      contentBytes: null,
      storageProvider: "fs",
      storageKey,
      byteSize: stored.byteSize,
      sha256: `sha256:${stored.sha256}`,
      source: body.source,
      provenance: body.provenance,
      safetyDigest: body.safetyDigest,
      createdBySubjectId: subject.subjectId,
    });
    const out = {
      mediaId: obj.mediaId,
      mediaRef: `media:${obj.mediaId}`,
      tenantId: obj.tenantId,
      spaceId: obj.spaceId,
      contentType: obj.contentType,
      byteSize: obj.byteSize,
      sha256: obj.sha256,
      status: obj.status,
    };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/media/uploads", async (req) => {
    const body = z
      .object({
        spaceId: z.string().min(1).optional(),
        contentType: z.string().min(1).max(200),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "media", action: "upload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "upload" });
    const subject = req.ctx.subject!;

    const spaceId = body.spaceId ?? subject.spaceId;
    if (!spaceId) throw Errors.badRequest("缺少 spaceId");
    if (subject.spaceId && subject.spaceId !== spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const expiresAt = new Date(Date.now() + Number(app.cfg.media.upload.expiresSec) * 1000);
    const up = await createUpload({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId,
      contentType: body.contentType,
      expiresAt,
      createdBySubjectId: subject.subjectId,
    });
    const out = { uploadId: up.uploadId, status: up.status, contentType: up.contentType, expiresAt: up.expiresAt };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.put("/media/uploads/:uploadId/parts/:partNumber", async (req) => {
    const params = z.object({ uploadId: z.string().uuid(), partNumber: z.coerce.number().int().min(1).max(10_000) }).parse(req.params);
    setAuditContext(req, { resourceType: "media", action: "upload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "upload" });
    const subject = req.ctx.subject!;

    const upload = await getUpload({ pool: app.db, tenantId: subject.tenantId, uploadId: params.uploadId });
    if (!upload) throw Errors.badRequest("Upload 不存在");
    if (upload.status !== "open") throw Errors.badRequest("Upload 不可用");
    if (new Date(upload.expiresAt).getTime() < Date.now()) throw Errors.badRequest("Upload 已过期");
    if (subject.spaceId && subject.spaceId !== upload.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const buf = req.body as any;
    if (!buf || !Buffer.isBuffer(buf)) throw Errors.badRequest("需要二进制分片内容");
    if (!buf.length) throw Errors.badRequest("分片内容为空");
    if (buf.length > Number(app.cfg.media.upload.maxPartBytes)) throw Errors.badRequest("分片过大");

    const partsNow = await listParts({ pool: app.db, uploadId: upload.uploadId });
    const old = partsNow.find((p) => p.partNumber === params.partNumber);
    const totalNow = partsNow.reduce((acc, p) => acc + p.byteSize, 0);
    const totalNext = totalNow - (old?.byteSize ?? 0) + buf.length;
    if (totalNext > Number(app.cfg.media.upload.maxTotalBytes)) throw Errors.badRequest("总大小超限");

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const storageKey = `uploads/${upload.tenantId}/${upload.uploadId}/${params.partNumber}`;
    await fsPut({ rootDir: app.cfg.media.fsRootDir, storageKey, bytes: buf });
    await upsertPart({
      pool: app.db,
      uploadId: upload.uploadId,
      partNumber: params.partNumber,
      storageProvider: "fs",
      storageKey,
      byteSize: buf.length,
      sha256: `sha256:${sha256}`,
    });

    req.ctx.audit!.inputDigest = { uploadId: upload.uploadId, partNumber: params.partNumber, byteSize: buf.length };
    const out = { uploadId: upload.uploadId, partNumber: params.partNumber, byteSize: buf.length, sha256: `sha256:${sha256}` };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/media/uploads/:uploadId/complete", async (req) => {
    const params = z.object({ uploadId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "media", action: "upload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "upload" });
    const subject = req.ctx.subject!;

    const upload = await getUpload({ pool: app.db, tenantId: subject.tenantId, uploadId: params.uploadId });
    if (!upload) throw Errors.badRequest("Upload 不存在");
    if (upload.status !== "open") throw Errors.badRequest("Upload 不可用");
    if (new Date(upload.expiresAt).getTime() < Date.now()) throw Errors.badRequest("Upload 已过期");
    if (subject.spaceId && subject.spaceId !== upload.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const parts = await listParts({ pool: app.db, uploadId: upload.uploadId });
    if (!parts.length) throw Errors.badRequest("缺少分片");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].partNumber !== i + 1) throw Errors.badRequest("分片不连续");
    }
    const totalBytes = parts.reduce((acc, p) => acc + p.byteSize, 0);
    if (totalBytes > Number(app.cfg.media.upload.maxTotalBytes)) throw Errors.badRequest("总大小超限");

    const targetKey = `objects/${upload.tenantId}/${upload.uploadId}`;
    const composed = await fsCompose({ rootDir: app.cfg.media.fsRootDir, sourceKeys: parts.map((p) => p.storageKey), targetKey });

    const obj = await createMediaObject({
      pool: app.db,
      tenantId: upload.tenantId,
      spaceId: upload.spaceId,
      contentType: upload.contentType,
      contentBytes: null,
      storageProvider: "fs",
      storageKey: targetKey,
      byteSize: composed.byteSize,
      sha256: `sha256:${composed.sha256}`,
      source: { kind: "multipart", uploadId: upload.uploadId, partCount: parts.length },
      createdBySubjectId: subject.subjectId,
    });

    await setUploadStatus({ pool: app.db, uploadId: upload.uploadId, status: "completed", totalBytes });
    await Promise.all(parts.map((p) => fsDelete({ rootDir: app.cfg.media.fsRootDir, storageKey: p.storageKey }).catch(() => undefined)));

    const out = { mediaId: obj.mediaId, mediaRef: `media:${obj.mediaId}`, byteSize: obj.byteSize, sha256: obj.sha256, partCount: parts.length };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.post("/media/uploads/:uploadId/abort", async (req) => {
    const params = z.object({ uploadId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "media", action: "upload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "upload" });
    const subject = req.ctx.subject!;

    const upload = await getUpload({ pool: app.db, tenantId: subject.tenantId, uploadId: params.uploadId });
    if (!upload) throw Errors.badRequest("Upload 不存在");
    if (subject.spaceId && subject.spaceId !== upload.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const parts = await listParts({ pool: app.db, uploadId: upload.uploadId });
    await setUploadStatus({ pool: app.db, uploadId: upload.uploadId, status: "aborted" });
    await Promise.all(parts.map((p) => fsDelete({ rootDir: app.cfg.media.fsRootDir, storageKey: p.storageKey }).catch(() => undefined)));
    await app.db.query("DELETE FROM media_upload_parts WHERE upload_id = $1", [upload.uploadId]);
    req.ctx.audit!.outputDigest = { uploadId: upload.uploadId, status: "aborted" };
    return { uploadId: upload.uploadId, status: "aborted" };
  });

  app.get("/media/objects/:mediaId", async (req) => {
    const params = z.object({ mediaId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "media", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "read" });
    const subject = req.ctx.subject!;
    const obj = await getMediaObject({ pool: app.db, tenantId: subject.tenantId, mediaId: params.mediaId });
    if (!obj) throw Errors.badRequest("MediaObject 不存在");
    if (subject.spaceId && subject.spaceId !== obj.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const out = { ...obj, mediaRef: `media:${obj.mediaId}` };
    req.ctx.audit!.outputDigest = { mediaId: obj.mediaId, status: obj.status, byteSize: obj.byteSize };
    return out;
  });

  app.get("/media/objects/:mediaId/download", async (req, reply) => {
    const params = z.object({ mediaId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "media", action: "download" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "download" });
    const subject = req.ctx.subject!;
    const obj = await getMediaContent({ pool: app.db, tenantId: subject.tenantId, mediaId: params.mediaId });
    if (!obj) throw Errors.badRequest("MediaObject 不存在");
    if (subject.spaceId && subject.spaceId !== obj.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const bytes =
      obj.storageProvider === "fs" && obj.storageKey
        ? (await fsGet({ rootDir: app.cfg.media.fsRootDir, storageKey: obj.storageKey })).bytes
        : obj.contentBytes;
    if (!bytes) throw Errors.badRequest("内容不可用");
    const audit = req.ctx.audit!;
    audit.outputDigest = { mediaId: obj.mediaId, contentType: obj.contentType, byteSize: obj.byteSize };
    audit.skipAuditWrite = true;
    try {
      const latencyMs = audit.startedAtMs ? Date.now() - audit.startedAtMs : undefined;
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: audit.resourceType!,
        action: audit.action!,
        toolRef: audit.toolRef,
        workflowRef: audit.workflowRef,
        policyDecision: audit.policyDecision,
        inputDigest: audit.inputDigest,
        outputDigest: audit.outputDigest,
        idempotencyKey: audit.idempotencyKey,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        errorCategory: audit.errorCategory,
        latencyMs,
      });
    } catch {
      reply.status(500);
      return {
        errorCode: "AUDIT_WRITE_FAILED",
        message: Errors.auditWriteFailed().messageI18n,
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      };
    }
    reply.header("content-type", obj.contentType);
    return bytes;
  });

  app.post("/media/objects/:mediaId/process", async (req) => {
    const params = z.object({ mediaId: z.string().uuid() }).parse(req.params);
    const body = z.object({ ops: z.array(z.enum(["thumbnail", "transcript", "extractText", "transcode"])).min(1).max(10) }).parse(req.body);
    setAuditContext(req, { resourceType: "media", action: "process.requested" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "media", action: "process" });
    const subject = req.ctx.subject!;

    const obj = await getMediaObject({ pool: app.db, tenantId: subject.tenantId, mediaId: params.mediaId });
    if (!obj) throw Errors.badRequest("MediaObject 不存在");
    if (subject.spaceId && subject.spaceId !== obj.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const job = await createMediaJob({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: obj.spaceId,
      mediaId: obj.mediaId,
      ops: body.ops,
      createdBySubjectId: subject.subjectId,
    });

    await app.queue.add(
      "step",
      { kind: "media.process", tenantId: subject.tenantId, jobId: job.jobId },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
    );

    req.ctx.audit!.outputDigest = { mediaId: obj.mediaId, jobId: job.jobId, ops: body.ops };
    return { jobId: job.jobId, status: job.status };
  });
};
