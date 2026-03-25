import type { FastifyRequest } from "fastify";

export function setAuditContext(
  req: FastifyRequest,
  ctx: Partial<FastifyRequest["ctx"]["audit"]> & { resourceType: string; action: string },
) {
  (req as any).ctx ??= {
    traceId: (req.headers["x-trace-id"] as string | undefined) ?? "",
    locale: (req.headers["x-user-locale"] as string | undefined) ?? "zh-CN",
  };
  req.ctx.audit ??= {};
  req.ctx.audit.resourceType = ctx.resourceType;
  req.ctx.audit.action = ctx.action;
  req.ctx.audit.toolRef = ctx.toolRef;
  req.ctx.audit.workflowRef = ctx.workflowRef;
  req.ctx.audit.idempotencyKey = ctx.idempotencyKey;
  req.ctx.audit.requireOutbox = ctx.requireOutbox;
}
