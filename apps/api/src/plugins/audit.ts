import type { FastifyPluginAsync } from "fastify";
import { Errors } from "../lib/errors";
import { AuditContractError, insertAuditEvent, isHighRiskAuditAction, normalizeAuditErrorCategory } from "../modules/audit/auditRepo";
import { enqueueAuditOutbox } from "../modules/audit/outboxRepo";
import { buildAuditEventFromRequest } from "../modules/audit/requestOutbox";
import { digestBody, digestPayload, mergeOutputDigest } from "./digests";

function resolveAuditCorrelation(req: any) {
  const audit = req?.ctx?.audit as any;
  const runId = String(audit?.runId ?? "").trim() || null;
  const stepId = String(audit?.stepId ?? "").trim() || null;
  const policySnapshotRef = String(audit?.policySnapshotRef ?? "").trim() || null;
  return { runId, stepId, policySnapshotRef };
}

function buildAuditContextRequiredResponse(params: { req: any; missing: string[] }) {
  return {
    errorCode: "AUDIT_CONTEXT_REQUIRED",
    message: {
      "zh-CN": "高风险动作缺少审计上下文",
      "en-US": "High-risk action missing audit context",
    },
    details: { missing: params.missing },
    traceId: params.req.ctx.traceId,
    requestId: params.req.ctx.requestId,
  };
}

export const auditPlugin: FastifyPluginAsync = async (app) => {
  async function enqueueReadAuditOutboxFallback(params: { req: any; result: "success" | "denied" | "error" }) {
    const subject = params.req.ctx.subject;
    if (!subject?.tenantId) throw new Error("subject_missing");
    const event = buildAuditEventFromRequest({ req: params.req, result: params.result });
    const traceId = String(event.traceId ?? "").trim();
    const requestId = String(event.requestId ?? "").trim();
    const resourceType = String(event.resourceType ?? "").trim();
    const action = String(event.action ?? "").trim();
    if (!traceId || !requestId || !resourceType || !action) throw new Error("audit_dedupe_key_missing");

    const ae = await app.db.query(
      `
        SELECT 1
        FROM audit_events
        WHERE tenant_id = $1
          AND trace_id = $2
          AND request_id = $3
          AND resource_type = $4
          AND action = $5
        LIMIT 1
      `,
      [subject.tenantId, traceId, requestId, resourceType, action],
    );
    if (ae.rowCount) return { mode: "deduped_audit_events" as const };

    const ob = await app.db.query(
      `
        SELECT outbox_id
        FROM audit_outbox
        WHERE tenant_id = $1
          AND (event->>'traceId') = $2
          AND (event->>'requestId') = $3
          AND (event->>'resourceType') = $4
          AND (event->>'action') = $5
          AND status IN ('queued','processing','failed')
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [subject.tenantId, traceId, requestId, resourceType, action],
    );
    if (ob.rowCount) return { mode: "deduped_outbox" as const, outboxId: String(ob.rows[0].outbox_id) };

    const r = await enqueueAuditOutbox({ db: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, event });
    return { mode: "enqueued" as const, outboxId: r.outboxId };
  }

  async function tryWriteAuditEvent(params: { req: any; reply: any; result: "success" | "denied" | "error"; latencyMs?: number }) {
    const audit = params.req.ctx.audit;
    const corr = resolveAuditCorrelation(params.req);
    const missing: string[] = [];
    if (isHighRiskAuditAction({ resourceType: audit.resourceType, action: audit.action })) {
      if (!corr.runId) missing.push("runId");
      if (!corr.stepId) missing.push("stepId");
      if (!corr.policySnapshotRef) missing.push("policySnapshotRef");
      if (missing.length > 0) {
        audit.errorCategory = "policy_violation";
        params.reply.status(409);
        return buildAuditContextRequiredResponse({ req: params.req, missing });
      }
    }
    try {
      await insertAuditEvent(app.db, {
        subjectId: params.req.ctx.subject?.subjectId,
        tenantId: params.req.ctx.subject?.tenantId,
        spaceId: params.req.ctx.subject?.spaceId,
        resourceType: audit.resourceType,
        action: audit.action,
        toolRef: audit.toolRef,
        workflowRef: audit.workflowRef,
        policyDecision: audit.policyDecision,
        inputDigest: audit.inputDigest,
        outputDigest: audit.outputDigest,
        idempotencyKey: audit.idempotencyKey,
        result: params.result,
        traceId: params.req.ctx.traceId,
        requestId: params.req.ctx.requestId,
        runId: corr.runId ?? undefined,
        stepId: corr.stepId ?? undefined,
        policySnapshotRef: corr.policySnapshotRef ?? undefined,
        errorCategory: normalizeAuditErrorCategory(audit.errorCategory) ?? undefined,
        latencyMs: params.latencyMs,
      });
      (audit as any).auditWritten = true;
      return null;
    } catch (e: any) {
      if (e instanceof AuditContractError && e.errorCode === "AUDIT_CONTEXT_REQUIRED") {
        audit.errorCategory = "policy_violation";
        params.reply.status(409);
        const missingFromError = Array.isArray((e as any).details?.missing) ? ((e as any).details.missing as string[]) : ["runId", "stepId", "policySnapshotRef"];
        return buildAuditContextRequiredResponse({ req: params.req, missing: missingFromError });
      }
      const mustSucceed = audit.action !== "read";
      if (mustSucceed) {
        audit.skipAuditWrite = true;
        app.metrics.incAuditWriteFailed({ errorCode: "AUDIT_WRITE_FAILED" });
        params.reply.status(500);
        return {
          errorCode: "AUDIT_WRITE_FAILED",
          message: Errors.auditWriteFailed().messageI18n,
          traceId: params.req.ctx.traceId,
          requestId: params.req.ctx.requestId,
        };
      }
      try {
        const r = await enqueueReadAuditOutboxFallback({ req: params.req, result: params.result });
        audit.outboxEnqueued = true;
        audit.skipAuditWrite = true;
        app.metrics.incAuditOutboxEnqueue({ result: "ok", kind: "read_fallback" });
        audit.outputDigest = mergeOutputDigest(audit.outputDigest, { auditOutbox: { mode: r.mode, outboxId: (r as any).outboxId ?? null } });
        return null;
      } catch (e2: any) {
        audit.skipAuditWrite = true;
        app.metrics.incAuditOutboxEnqueue({ result: "failed", kind: "read_fallback" });
        params.reply.status(500);
        return {
          errorCode: "AUDIT_OUTBOX_WRITE_FAILED",
          message: Errors.auditOutboxWriteFailed().messageI18n,
          traceId: params.req.ctx.traceId,
          requestId: params.req.ctx.requestId,
        };
      }
    }
  }

  function resolveResult(reply: any): "success" | "denied" | "error" {
    return reply.statusCode >= 200 && reply.statusCode < 400
      ? "success"
      : reply.statusCode === 401 || reply.statusCode === 403
        ? "denied"
        : "error";
  }

  async function finalizeAudit(params: { req: any; reply: any; payload: any; mergeDigest: boolean }): Promise<any> {
    const audit = params.req.ctx.audit;
    if (!audit?.resourceType || !audit?.action) return params.payload;
    if ((audit as any).auditWritten) return params.payload;

    if (params.mergeDigest) {
      audit.outputDigest = mergeOutputDigest(audit.outputDigest, digestPayload(params.payload) ?? digestBody(params.payload));
    }

    const latencyMs = audit.startedAtMs ? Date.now() - audit.startedAtMs : undefined;
    const result = resolveResult(params.reply);

    if (audit.requireOutbox && result === "success" && !audit.outboxEnqueued) {
      audit.errorCategory ??= "internal_error";
      app.metrics.incAuditWriteFailed({ errorCode: "AUDIT_OUTBOX_REQUIRED" });
      params.reply.status(500);
      return {
        errorCode: "AUDIT_OUTBOX_REQUIRED",
        message: Errors.auditOutboxRequired().messageI18n,
        traceId: params.req.ctx.traceId,
        requestId: params.req.ctx.requestId,
      };
    }

    if (audit.skipAuditWrite) return params.payload;

    const auditWriteOut = await tryWriteAuditEvent({ req: params.req, reply: params.reply, result, latencyMs });
    if (auditWriteOut) {
      if (typeof params.payload === "string" || Buffer.isBuffer(params.payload)) {
        params.reply.header("content-type", "application/json; charset=utf-8");
        return JSON.stringify(auditWriteOut);
      }
      return auditWriteOut;
    }

    return params.payload;
  }

  app.addHook("onSend", async (req, reply, payload) => {
    return finalizeAudit({ req, reply, payload, mergeDigest: true });
  });

  app.addHook("preSerialization", async (req, reply, payload) => {
    return finalizeAudit({ req, reply, payload, mergeDigest: false });
  });
};
