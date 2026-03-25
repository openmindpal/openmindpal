import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { getSpaceDefaultLocale, getTenantDefaultLocale, setSpaceDefaultLocale, setTenantDefaultLocale } from "../modules/settings/localeDefaultsRepo";
import { getTenantStepPayloadRetentionDays, setTenantStepPayloadRetentionDays } from "../modules/settings/stepPayloadRetentionRepo";

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/settings/locale-defaults", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "locale.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "locale.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const tenantDefaultLocale = await getTenantDefaultLocale({ pool: app.db, tenantId: subject.tenantId });
    const spaceDefaultLocale = subject.spaceId ? await getSpaceDefaultLocale({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId }) : null;
    const out = {
      tenantId: subject.tenantId,
      tenantDefaultLocale,
      spaceId: subject.spaceId ?? null,
      spaceDefaultLocale,
      effectiveLocale: req.ctx.locale,
    };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.put("/settings/tenant-locale", async (req) => {
    const body = z.object({ defaultLocale: z.string().min(1).max(50) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "locale.tenant.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "locale.update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const before = await getTenantDefaultLocale({ pool: app.db, tenantId: subject.tenantId });
    const after = await setTenantDefaultLocale({ pool: app.db, tenantId: subject.tenantId, defaultLocale: body.defaultLocale });
    if (!after) throw Errors.badRequest("Tenant 不存在");
    req.ctx.audit!.inputDigest = { tenantId: subject.tenantId, before, after };
    req.ctx.audit!.outputDigest = { tenantId: subject.tenantId, defaultLocale: after };
    return { tenantId: subject.tenantId, defaultLocale: after };
  });

  app.put("/settings/space-locale", async (req) => {
    const body = z.object({ spaceId: z.string().min(1).optional(), defaultLocale: z.string().min(1).max(50) }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "locale.space.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "locale.update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const spaceId = body.spaceId ?? subject.spaceId;
    if (!spaceId) throw Errors.badRequest("缺少 spaceId");
    const before = await getSpaceDefaultLocale({ pool: app.db, tenantId: subject.tenantId, spaceId });
    const after = await setSpaceDefaultLocale({ pool: app.db, tenantId: subject.tenantId, spaceId, defaultLocale: body.defaultLocale });
    if (!after) throw Errors.badRequest("Space 不存在");
    req.ctx.audit!.inputDigest = { tenantId: subject.tenantId, spaceId, before, after };
    req.ctx.audit!.outputDigest = { tenantId: subject.tenantId, spaceId, defaultLocale: after };
    return { tenantId: subject.tenantId, spaceId, defaultLocale: after };
  });

  app.get("/settings/workflow-step-payload-retention", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "workflow.stepPayloadRetention.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.stepPayloadRetention.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const raw = await getTenantStepPayloadRetentionDays({ pool: app.db, tenantId: subject.tenantId });
    const effective = raw === null ? 7 : raw;
    const out = { tenantId: subject.tenantId, retentionDays: raw, effectiveRetentionDays: effective };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.put("/settings/workflow-step-payload-retention", async (req) => {
    const body = z.object({ retentionDays: z.number().int().min(0).max(365).nullable() }).parse(req.body);
    setAuditContext(req, { resourceType: "governance", action: "workflow.stepPayloadRetention.update" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "workflow.stepPayloadRetention.update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const before = await getTenantStepPayloadRetentionDays({ pool: app.db, tenantId: subject.tenantId });
    const after = await setTenantStepPayloadRetentionDays({ pool: app.db, tenantId: subject.tenantId, retentionDays: body.retentionDays });
    if (after === null && before === null) throw Errors.badRequest("Tenant 不存在");
    req.ctx.audit!.inputDigest = { tenantId: subject.tenantId, before, after: body.retentionDays };
    req.ctx.audit!.outputDigest = { tenantId: subject.tenantId, retentionDays: body.retentionDays, effectiveRetentionDays: body.retentionDays === null ? 7 : body.retentionDays };
    return { tenantId: subject.tenantId, retentionDays: body.retentionDays, effectiveRetentionDays: body.retentionDays === null ? 7 : body.retentionDays };
  });
};
