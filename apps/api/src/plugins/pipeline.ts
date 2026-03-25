import type { FastifyPluginAsync } from "fastify";

export const requestPipelinePlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    (req as any).ctx ??= {
      traceId: (req.headers["x-trace-id"] as string | undefined) ?? "",
      locale: (req.headers["x-user-locale"] as string | undefined) ?? "zh-CN",
    };
    const auth = req.headers.authorization;
    if (!auth) return;

    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const spaceId = req.headers["x-space-id"] as string | undefined;
    req.ctx.subject = {
      subjectId: token || "anonymous",
      tenantId,
      spaceId,
    };
  });

  app.addHook("preValidation", async () => {
    return;
  });

  app.addHook("preHandler", async () => {
    return;
  });

  app.addHook("onResponse", async () => {
    return;
  });
};
