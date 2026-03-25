import type { FastifyPluginAsync } from "fastify";

export const idempotencyKeyPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    req.ctx.audit ??= {};
    req.ctx.audit.idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      req.ctx.audit.idempotencyKey;
  });
};
