import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { resolveRequestLocale } from "../lib/locale";

export const requestContextPlugin: FastifyPluginAsync<{
  platformLocale: string;
}> = async (app, opts) => {
  app.addHook("onRequest", async (req) => {
    const traceId = (req.headers["x-trace-id"] as string | undefined) ?? uuidv4();
    const requestId = uuidv4();
    const locale = resolveRequestLocale({
      userLocale: req.headers["x-user-locale"] as string | undefined,
      spaceLocale: req.headers["x-space-locale"] as string | undefined,
      tenantLocale: req.headers["x-tenant-locale"] as string | undefined,
      acceptLanguage: req.headers["accept-language"] as string | undefined,
      platformLocale: opts.platformLocale,
    });

    req.ctx = {
      traceId,
      requestId,
      locale,
    };
  });
};
