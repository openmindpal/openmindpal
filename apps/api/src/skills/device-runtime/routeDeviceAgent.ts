import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { getDevicePolicy } from "./modules/devicePolicyRepo";
import { activateDeviceWithToken, getDeviceRecord, updateDeviceLastSeen } from "./modules/deviceRepo";
import { consumeDevicePairing } from "./modules/pairingRepo";
import { randomCode, sha256Hex } from "./modules/crypto";
import crypto from "node:crypto";
import { createArtifact } from "../artifact-manager/modules/artifactRepo";

function requireDevice(req: any) {
  const device = req.ctx.device;
  if (!device) throw Errors.unauthorized(req.ctx.locale);
  return device as { deviceId: string; tenantId: string; spaceId: string | null; ownerScope: string; ownerSubjectId: string | null };
}

export const deviceAgentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/device-agent/pair", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "pair" });
    const body = z
      .object({
        pairingCode: z.string().min(10),
        deviceType: z.enum(["desktop", "mobile"]),
        os: z.string().min(1).max(100),
        agentVersion: z.string().min(1).max(100),
      })
      .parse(req.body);

    const codeHash = sha256Hex(body.pairingCode);
    const pairing = await consumeDevicePairing({ pool: app.db, codeHash });
    if (!pairing) throw Errors.badRequest("配对码无效或已过期");

    const device = await getDeviceRecord({ pool: app.db, tenantId: pairing.tenantId, deviceId: pairing.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    if (device.status !== "pending") throw Errors.badRequest("Device 状态不允许配对");

    const subject = req.ctx.subject;
    if (subject && (subject.tenantId !== device.tenantId || subject.spaceId !== (device.spaceId ?? undefined))) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const deviceToken = randomCode("devtok_");
    const activated = await activateDeviceWithToken({
      pool: app.db,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      deviceTokenHash: sha256Hex(deviceToken),
      deviceType: body.deviceType,
      os: body.os,
      agentVersion: body.agentVersion,
    });
    if (!activated) throw Errors.badRequest("Device 状态不允许配对");

    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, token: { sha256_8: sha256Hex(deviceToken).slice(0, 8) } };
    const policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    return { deviceId: device.deviceId, deviceToken, policy };
  });

  app.post("/device-agent/heartbeat", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "heartbeat" });
    const body = z.object({ os: z.string().min(1).max(100), agentVersion: z.string().min(1).max(100) }).parse(req.body);

    const device = requireDevice(req);
    const updated = await updateDeviceLastSeen({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId, os: body.os, agentVersion: body.agentVersion });
    if (!updated) throw Errors.unauthorized(req.ctx.locale);
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, ok: true };
    return { ok: true };
  });

  app.post("/device-agent/evidence/upload", async (req, reply) => {
    setAuditContext(req, { resourceType: "device", action: "evidence.upload" });
    const device = requireDevice(req);
    const body = z
      .object({
        deviceExecutionId: z.string().uuid().optional(),
        contentBase64: z.string().min(8),
        contentType: z.string().min(3).max(200),
        format: z.string().min(1).max(50).optional(),
      })
      .parse(req.body);

    const policy = await getDevicePolicy({ pool: app.db, tenantId: device.tenantId, deviceId: device.deviceId });
    const ep = policy?.evidencePolicy ?? null;
    const allowUpload = Boolean(ep && typeof ep === "object" && (ep as any).allowUpload);
    if (!allowUpload) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (!device.spaceId) throw Errors.badRequest("缺少 spaceId");
    const allowedTypes = Array.isArray((ep as any)?.allowedTypes) ? ((ep as any).allowedTypes as any[]).map((x) => String(x)) : [];
    if (allowedTypes.length && !allowedTypes.includes(body.contentType)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const base64 = body.contentBase64.trim();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw Errors.badRequest("contentBase64 非法");
    }
    const maxBytes = Math.max(1, Number(process.env.DEVICE_EVIDENCE_MAX_UPLOAD_BYTES ?? "1048576") || 1048576);
    if (bytes.byteLength > maxBytes) throw Errors.badRequest("证据过大");

    const retentionDaysRaw = Number((ep as any)?.retentionDays ?? 7);
    const retentionDays = Number.isFinite(retentionDaysRaw) ? Math.max(1, Math.min(365, Math.floor(retentionDaysRaw))) : 7;
    const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const artifactId = crypto.randomUUID();
    const art = await createArtifact({
      pool: app.db,
      artifactId,
      tenantId: device.tenantId,
      spaceId: device.spaceId,
      type: "device_evidence",
      format: body.format ?? "base64",
      contentType: body.contentType,
      contentText: base64,
      source: { kind: "device_evidence", deviceId: device.deviceId, deviceExecutionId: body.deviceExecutionId ?? null },
      createdBySubjectId: null,
      expiresAt,
    });
    req.ctx.audit!.inputDigest = { contentType: body.contentType, byteSize: bytes.byteLength, deviceExecutionId: body.deviceExecutionId ?? null };
    req.ctx.audit!.outputDigest = { artifactId: art.artifactId, expiresAt: art.expiresAt, type: art.type, format: art.format };
    return reply.status(200).send({ artifactId: art.artifactId, evidenceRef: `artifact:${art.artifactId}`, expiresAt: art.expiresAt });
  });
};
