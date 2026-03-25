import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { getDevicePolicy, upsertDevicePolicy } from "../modules/devices/devicePolicyRepo";
import { createDeviceRecord, getDeviceRecord, listDeviceRecords, revokeDeviceRecord } from "../modules/devices/deviceRepo";
import { createDevicePairing } from "../modules/devices/pairingRepo";
import { randomCode, sha256Hex } from "../modules/devices/crypto";

function resolveOwner(subject: { tenantId: string; spaceId?: string | null; subjectId: string }, ownerScope?: "user" | "space") {
  if (ownerScope === "user") return { ownerScope: "user" as const, ownerSubjectId: subject.subjectId, spaceId: null as string | null };
  if (ownerScope === "space") {
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    return { ownerScope: "space" as const, ownerSubjectId: null as string | null, spaceId: subject.spaceId };
  }
  if (subject.spaceId) return { ownerScope: "space" as const, ownerSubjectId: null as string | null, spaceId: subject.spaceId };
  return { ownerScope: "user" as const, ownerSubjectId: subject.subjectId, spaceId: null as string | null };
}

function assertOwnerMatch(subject: { subjectId: string; spaceId?: string | null }, device: { ownerScope: string; ownerSubjectId: string | null; spaceId: string | null }) {
  if (device.ownerScope === "user") {
    if (device.ownerSubjectId !== subject.subjectId) throw Errors.forbidden();
    return;
  }
  if (device.ownerScope === "space") {
    if (!subject.spaceId || device.spaceId !== subject.spaceId) throw Errors.forbidden();
    return;
  }
  throw Errors.forbidden();
}

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  app.post("/devices", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "create" });
    const decision = await requirePermission({ req, resourceType: "device", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        ownerScope: z.enum(["user", "space"]).optional(),
        deviceType: z.enum(["desktop", "mobile"]),
        os: z.string().min(1).max(100),
        agentVersion: z.string().min(1).max(100),
      })
      .parse(req.body);
    const owner = resolveOwner(subject, body.ownerScope);
    const device = await createDeviceRecord({
      pool: app.db,
      tenantId: subject.tenantId,
      ownerScope: owner.ownerScope,
      ownerSubjectId: owner.ownerSubjectId,
      spaceId: owner.spaceId,
      deviceType: body.deviceType,
      os: body.os,
      agentVersion: body.agentVersion,
    });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, status: device.status, ownerScope: device.ownerScope };
    return { device };
  });

  app.get("/devices", async (req) => {
    setAuditContext(req, { resourceType: "device", action: "read" });
    const decision = await requirePermission({ req, resourceType: "device", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        ownerScope: z.enum(["user", "space"]).optional(),
      })
      .parse(req.query);
    const owner = resolveOwner(subject, q.ownerScope);
    const devices = await listDeviceRecords({
      pool: app.db,
      tenantId: subject.tenantId,
      ownerScope: owner.ownerScope,
      ownerSubjectId: owner.ownerSubjectId,
      spaceId: owner.spaceId,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });
    req.ctx.audit!.outputDigest = { count: devices.length, ownerScope: owner.ownerScope, limit: q.limit ?? 20, offset: q.offset ?? 0 };
    return { devices };
  });

  app.get("/devices/:deviceId", async (req, reply) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device", action: "read" });
    const decision = await requirePermission({ req, resourceType: "device", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const device = await getDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: params.deviceId });
    if (!device) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Device 不存在", "en-US": "Device not found" }, traceId: req.ctx.traceId });
    assertOwnerMatch(subject, device);
    const policy = await getDevicePolicy({ pool: app.db, tenantId: subject.tenantId, deviceId: device.deviceId });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, status: device.status, hasPolicy: Boolean(policy) };
    return { device, policy };
  });

  app.post("/devices/:deviceId/pairing", async (req) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device", action: "pairing.create" });
    const decision = await requirePermission({ req, resourceType: "device", action: "pairing.create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const device = await getDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: params.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    assertOwnerMatch(subject, device);
    if (device.status !== "pending") throw Errors.badRequest("Device 状态不允许配对");

    const pairingCode = randomCode("pair_");
    const created = await createDevicePairing({ pool: app.db, tenantId: subject.tenantId, deviceId: device.deviceId, codeHash: sha256Hex(pairingCode), ttlSeconds: 600 });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, expiresAt: created.expiresAt, pairingCode: { sha256_8: sha256Hex(pairingCode).slice(0, 8) } };
    return { deviceId: device.deviceId, pairingCode, expiresAt: created.expiresAt };
  });

  app.post("/devices/:deviceId/revoke", async (req) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device", action: "revoke" });
    const decision = await requirePermission({ req, resourceType: "device", action: "revoke" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const device = await getDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: params.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    assertOwnerMatch(subject, device);

    const revoked = await revokeDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: params.deviceId });
    if (!revoked) throw Errors.badRequest("Device 不存在");
    req.ctx.audit!.outputDigest = { deviceId: revoked.deviceId, status: revoked.status };
    return { device: revoked };
  });

  app.put("/devices/:deviceId/policy", async (req) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "device", action: "policy.update" });
    const decision = await requirePermission({ req, resourceType: "device", action: "policy.update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const device = await getDeviceRecord({ pool: app.db, tenantId: subject.tenantId, deviceId: params.deviceId });
    if (!device) throw Errors.badRequest("Device 不存在");
    assertOwnerMatch(subject, device);

    const body = z
      .object({
        allowedTools: z.array(z.string()).optional(),
        filePolicy: z.record(z.string(), z.any()).optional(),
        networkPolicy: z.object({ allowedDomains: z.array(z.string()).optional() }).optional(),
        uiPolicy: z.record(z.string(), z.any()).optional(),
        evidencePolicy: z.record(z.string(), z.any()).optional(),
        limits: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body);

    const policy = await upsertDevicePolicy({
      pool: app.db,
      tenantId: subject.tenantId,
      deviceId: device.deviceId,
      allowedTools: body.allowedTools ?? null,
      filePolicy: body.filePolicy ?? null,
      networkPolicy: body.networkPolicy ?? null,
      uiPolicy: body.uiPolicy ?? null,
      evidencePolicy: body.evidencePolicy ?? null,
      limits: body.limits ?? null,
    });
    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, hasAllowedTools: Boolean(body.allowedTools?.length) };
    return { policy };
  });
};
