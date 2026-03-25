import type { FastifyPluginAsync } from "fastify";
import { digestBody } from "./digests";

export const auditContextPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    req.ctx.audit ??= {};
    req.ctx.audit.startedAtMs = Date.now();
    req.ctx.audit.inputDigest = digestBody(req.body);
  });

  app.addHook("onError", async (req, _reply, err) => {
    req.ctx.audit ??= {};
    req.ctx.audit.lastError = err;
  });
};
