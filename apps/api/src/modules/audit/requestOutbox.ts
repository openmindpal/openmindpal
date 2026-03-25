import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { AuditEventInput } from "./auditRepo";
import { enqueueAuditOutbox } from "./outboxRepo";

export function buildAuditEventFromRequest(params: { req: FastifyRequest; result: AuditEventInput["result"] }): AuditEventInput {
  const audit = params.req.ctx.audit;
  const subject = params.req.ctx.subject;
  const startedAtMs = audit?.startedAtMs ?? Date.now();
  return {
    subjectId: subject?.subjectId,
    tenantId: subject?.tenantId,
    spaceId: subject?.spaceId,
    resourceType: audit?.resourceType ?? "unknown",
    action: audit?.action ?? "unknown",
    toolRef: audit?.toolRef,
    workflowRef: audit?.workflowRef,
    policyDecision: audit?.policyDecision,
    inputDigest: audit?.inputDigest,
    outputDigest: audit?.outputDigest,
    idempotencyKey: audit?.idempotencyKey,
    result: params.result,
    traceId: params.req.ctx.traceId,
    requestId: params.req.ctx.requestId,
    errorCategory: audit?.errorCategory,
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    timestamp: new Date(startedAtMs).toISOString(),
  };
}

export async function enqueueAuditOutboxForRequest(params: { client: PoolClient; req: FastifyRequest; event?: AuditEventInput; deferSkip?: boolean }) {
  const subject = params.req.ctx.subject;
  if (!subject) throw new Error("subject_missing");
  const event = params.event ?? buildAuditEventFromRequest({ req: params.req, result: "success" });
  const r = await enqueueAuditOutbox({ db: params.client, tenantId: subject.tenantId, spaceId: subject.spaceId, event });
  params.req.ctx.audit ??= {};
  params.req.ctx.audit.outboxEnqueued = true;
  if (!params.deferSkip) params.req.ctx.audit.skipAuditWrite = true;
  return r;
}
