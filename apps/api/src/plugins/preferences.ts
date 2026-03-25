import type { FastifyPluginAsync } from "fastify";
import { resolveRequestLocale } from "../lib/locale";
import { getUserLocalePreference } from "../lib/userPreferences";

export const preferencesPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    const subject = req.ctx.subject;
    if (!subject) return;
    const userLocaleHeader = req.headers["x-user-locale"] as string | undefined;
    const spaceLocaleHeader = req.headers["x-space-locale"] as string | undefined;
    const tenantLocaleHeader = req.headers["x-tenant-locale"] as string | undefined;

    let tenantDefaultLocale: string | undefined;
    const tenantRes = await app.db.query("SELECT default_locale FROM tenants WHERE id = $1 LIMIT 1", [subject.tenantId]);
    if (tenantRes.rowCount) tenantDefaultLocale = tenantRes.rows[0].default_locale as string;

    let spaceDefaultLocale: string | undefined;
    if (subject.spaceId) {
      const spaceRes = await app.db.query("SELECT default_locale FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [subject.spaceId, subject.tenantId]);
      if (spaceRes.rowCount) spaceDefaultLocale = spaceRes.rows[0].default_locale as string;
    }

    const userPrefLocale = userLocaleHeader ? null : await getUserLocalePreference({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });

    req.ctx.locale = resolveRequestLocale({
      userLocale: userLocaleHeader ?? userPrefLocale ?? undefined,
      spaceLocale: spaceLocaleHeader ?? spaceDefaultLocale,
      tenantLocale: tenantLocaleHeader ?? tenantDefaultLocale,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platformLocale: app.cfg.platformLocale,
    });
  });
};
