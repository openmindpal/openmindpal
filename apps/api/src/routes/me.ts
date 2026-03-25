import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSubject } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { getUserLocalePreference, setUserLocalePreference } from "../lib/userPreferences";

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (req) => {
    setAuditContext(req, { resourceType: "subject", action: "read" });
    const subject = requireSubject(req);
    return {
      subject,
      traceId: req.ctx.traceId,
      locale: req.ctx.locale,
    };
  });

  app.get("/me/preferences", async (req) => {
    setAuditContext(req, { resourceType: "subject", action: "preferences.read" });
    const subject = requireSubject(req);
    const locale = await getUserLocalePreference({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    req.ctx.audit!.outputDigest = { hasLocale: Boolean(locale) };
    return { locale };
  });

  app.put("/me/preferences", async (req) => {
    setAuditContext(req, { resourceType: "subject", action: "preferences.update" });
    const subject = requireSubject(req);
    const body = z.object({ locale: z.string().min(1).max(50) }).parse(req.body);
    const locale = await setUserLocalePreference({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, locale: body.locale });
    req.ctx.audit!.inputDigest = { locale };
    req.ctx.audit!.outputDigest = { locale };
    req.ctx.locale = locale;
    return { locale };
  });
};
