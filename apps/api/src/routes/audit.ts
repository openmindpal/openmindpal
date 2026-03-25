import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Errors } from "../lib/errors";
import { normalizeAuditErrorCategory } from "../modules/audit/auditRepo";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { createAuditExport, getAuditExport, listAuditExports } from "../modules/audit/exportRepo";
import { createAuditLegalHold, getAuditLegalHold, listAuditLegalHolds, releaseAuditLegalHold } from "../modules/audit/legalHoldRepo";
import { getAuditRetentionPolicy, upsertAuditRetentionPolicy } from "../modules/audit/retentionRepo";
import {
  clearAuditSiemDlq,
  clearAuditSiemOutbox,
  createAuditSiemDestination,
  getAuditSiemDestination,
  listAuditSiemDestinations,
  listAuditSiemDlq,
  requeueAuditSiemDlq,
  updateAuditSiemDestination,
  upsertAuditSiemCursor,
} from "../modules/audit/siemRepo";
import { getConnectorInstance, getConnectorType } from "../lib/connectorContract";
import { decryptSecretPayload } from "../modules/secrets/envelope";
import { getSecretRecord, getSecretRecordEncryptedPayload } from "../modules/secrets/secretRepo";

function masterKey() {
  return process.env.API_MASTER_KEY ?? "dev-master-key-change-me";
}

function getAllowedDomains(params: { connectorEgressPolicy: any; typeDefaultEgressPolicy: any }) {
  const p = params.connectorEgressPolicy ?? params.typeDefaultEgressPolicy ?? {};
  const a = Array.isArray(p.allowedDomains) ? p.allowedDomains.filter((x: any) => typeof x === "string" && x.length) : [];
  return a as string[];
}

function canonicalize(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const out: any = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize(value[k]);
  return out;
}

function stableStringify(value: any) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, normalized: params.normalized });
  return sha256Hex(input);
}

function resolveHighRiskContext(req: any, payload?: any) {
  const src = payload && typeof payload === "object" ? payload : {};
  const corr = src.correlation && typeof src.correlation === "object" ? src.correlation : {};
  const runId = String(corr.runId ?? src.runId ?? req.headers["x-run-id"] ?? "").trim();
  const stepId = String(corr.stepId ?? src.stepId ?? req.headers["x-step-id"] ?? "").trim();
  const policySnapshotRef = String(corr.policySnapshotRef ?? src.policySnapshotRef ?? req.headers["x-policy-snapshot-ref"] ?? "").trim();
  return {
    runId: runId || null,
    stepId: stepId || null,
    policySnapshotRef: policySnapshotRef || null,
  };
}

function mergeObject(base: unknown, patch: Record<string, unknown>) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return patch;
  return { ...(base as Record<string, unknown>), ...patch };
}

function requireHighRiskContext(req: any, payload?: any) {
  const ctx = resolveHighRiskContext(req, payload);
  const missing: string[] = [];
  if (!ctx.runId) missing.push("runId");
  if (!ctx.stepId) missing.push("stepId");
  if (!ctx.policySnapshotRef) missing.push("policySnapshotRef");
  const auditAny = (req.ctx.audit ?? {}) as any;
  if (missing.length > 0) {
    const fallback = `audit-context-missing:${req.ctx.requestId}`;
    auditAny.runId = ctx.runId ?? `${fallback}:run`;
    auditAny.stepId = ctx.stepId ?? `${fallback}:step`;
    auditAny.policySnapshotRef = ctx.policySnapshotRef ?? `policy_snapshot:${fallback}`;
    req.ctx.audit!.errorCategory = "policy_violation";
    req.ctx.audit!.outputDigest = mergeObject(req.ctx.audit!.outputDigest, { highRiskContextMissing: missing });
    return {
      errorCode: "AUDIT_CONTEXT_REQUIRED",
      message: {
        "zh-CN": "高风险动作缺少审计上下文",
        "en-US": "High-risk action missing audit context",
      },
      details: { missing },
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
    };
  }
  auditAny.runId = ctx.runId;
  auditAny.stepId = ctx.stepId;
  auditAny.policySnapshotRef = ctx.policySnapshotRef;
  req.ctx.audit!.inputDigest = mergeObject(req.ctx.audit!.inputDigest, { runId: ctx.runId, stepId: ctx.stepId, policySnapshotRef: ctx.policySnapshotRef });
  return null;
}

function normalizeAuditErrorCategoryInRequest(req: any) {
  req.ctx.audit!.errorCategory = normalizeAuditErrorCategory(req.ctx.audit!.errorCategory) ?? undefined;
}

async function getSiemDestinationGovernanceExtras(app: any, tenantId: string, destinationId: string) {
  try {
    const res = await app.db.query(
      `
        SELECT max_attempts, backoff_ms_base, dlq_threshold, alert_threshold, alert_enabled, last_alert_at, last_alert_digest
        FROM audit_siem_destinations
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
      `,
      [tenantId, destinationId],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0] as any;
    return {
      maxAttempts: Number(row.max_attempts ?? 8),
      backoffMsBase: Number(row.backoff_ms_base ?? 500),
      dlqThreshold: Number(row.dlq_threshold ?? 8),
      alertThreshold: Number(row.alert_threshold ?? 3),
      alertEnabled: Boolean(row.alert_enabled ?? true),
      lastAlertAt: row.last_alert_at ? String(row.last_alert_at) : null,
      lastAlertDigest: row.last_alert_digest ?? null,
    };
  } catch {
    return {
      maxAttempts: 8,
      backoffMsBase: 500,
      dlqThreshold: 8,
      alertThreshold: 3,
      alertEnabled: true,
      lastAlertAt: null,
      lastAlertDigest: null,
    };
  }
}

async function updateSiemDestinationGovernanceExtras(app: any, params: {
  tenantId: string;
  destinationId: string;
  maxAttempts?: number;
  backoffMsBase?: number;
  dlqThreshold?: number;
  alertThreshold?: number;
  alertEnabled?: boolean;
}) {
  try {
    await app.db.query(
      `
        UPDATE audit_siem_destinations
        SET max_attempts = COALESCE($3, max_attempts),
            backoff_ms_base = COALESCE($4, backoff_ms_base),
            dlq_threshold = COALESCE($5, dlq_threshold),
            alert_threshold = COALESCE($6, alert_threshold),
            alert_enabled = COALESCE($7, alert_enabled),
            updated_at = now()
        WHERE tenant_id = $1 AND id = $2
      `,
      [params.tenantId, params.destinationId, params.maxAttempts ?? null, params.backoffMsBase ?? null, params.dlqThreshold ?? null, params.alertThreshold ?? null, params.alertEnabled ?? null],
    );
  } catch {
  }
}

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/audit", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "read" });

    const q = z
      .object({
        traceId: z.string().optional(),
        subjectId: z.string().optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);

    const limit = q.limit ?? 50;
    const where: string[] = [];
    const args: any[] = [];

    if (q.traceId) {
      args.push(q.traceId);
      where.push(`trace_id = $${args.length}`);
    }
    if (q.subjectId) {
      args.push(q.subjectId);
      where.push(`subject_id = $${args.length}`);
    }
    if (q.action) {
      args.push(q.action);
      where.push(`action = $${args.length}`);
    }

    args.push(limit);
    const sql = `
      SELECT *
      FROM audit_events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp DESC
      LIMIT $${args.length}
    `;
    const res = await app.db.query(sql, args);
    return { events: res.rows };
  });

  app.get("/audit/verify", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "verify" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "verify" });

    const subject = req.ctx.subject!;
    const q = z
      .object({
        tenantId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().positive().max(20000).optional(),
      })
      .parse(req.query);

    const tenantId = q.tenantId ?? subject.tenantId;
    const limit = q.limit ?? 5000;
    const where: string[] = ["tenant_id = $1"];
    const args: any[] = [tenantId];
    where.push("event_hash IS NOT NULL");
    if (q.from) {
      args.push(q.from);
      where.push(`timestamp >= $${args.length}::timestamptz`);
    }
    if (q.to) {
      args.push(q.to);
      where.push(`timestamp <= $${args.length}::timestamptz`);
    }
    args.push(limit);

    const sql = `
      SELECT *
      FROM audit_events
      WHERE ${where.join(" AND ")}
      ORDER BY timestamp ASC, event_id ASC
      LIMIT $${args.length}
    `;
    const res = await app.db.query(sql, args);
    const events = res.rows as any[];

    let ok = true;
    let checkedCount = 0;
    let prevHash: string | null = null;
    if (q.from) {
      const prev = await app.db.query(
        `
          SELECT event_hash
          FROM audit_events
          WHERE tenant_id = $1
            AND event_hash IS NOT NULL
            AND timestamp < $2::timestamptz
          ORDER BY timestamp DESC, event_id DESC
          LIMIT 1
        `,
        [tenantId, q.from],
      );
      prevHash = prev.rowCount ? (prev.rows[0].event_hash as string | null) : null;
    }
    if (q.from && prevHash === null && events.length) prevHash = (events[0].prev_hash as string | null) ?? null;
    const failures: Array<{ eventId: string; reason: string }> = [];

    for (const ev of events) {
      const expectedPrev = prevHash;
      const storedPrev = (ev.prev_hash as string | null) ?? null;
      if (storedPrev !== expectedPrev) {
        if (q.from && checkedCount === 0) {
          prevHash = (ev.event_hash as string | null) ?? null;
          checkedCount += 1;
          continue;
        }
        ok = false;
        failures.push({ eventId: String(ev.event_id), reason: "prev_hash_mismatch" });
        prevHash = (ev.event_hash as string | null) ?? null;
        checkedCount += 1;
        if (failures.length >= 20) break;
        continue;
      }

      const normalized = {
        timestamp: new Date(ev.timestamp).toISOString(),
        subjectId: ev.subject_id ?? null,
        tenantId: ev.tenant_id ?? null,
        spaceId: ev.space_id ?? null,
        resourceType: ev.resource_type,
        action: ev.action,
        toolRef: ev.tool_ref ?? null,
        workflowRef: ev.workflow_ref ?? null,
        result: ev.result,
        traceId: ev.trace_id,
        requestId: ev.request_id ?? null,
        runId: ev.run_id ?? null,
        stepId: ev.step_id ?? null,
        idempotencyKey: ev.idempotency_key ?? null,
        errorCategory: ev.error_category ?? null,
        latencyMs: ev.latency_ms ?? null,
        policyDecision: ev.policy_decision ?? null,
        inputDigest: ev.input_digest ?? null,
        outputDigest: ev.output_digest ?? null,
        outboxId: ev.outbox_id ?? null,
      };

      const storedHash = (ev.event_hash as string | null) ?? null;
      if (!storedHash) {
        ok = false;
        failures.push({ eventId: String(ev.event_id), reason: "event_hash_missing" });
        prevHash = storedHash;
        checkedCount += 1;
        if (failures.length >= 20) break;
        continue;
      }

      prevHash = storedHash;
      checkedCount += 1;
    }

    const firstEventId = events.length ? String(events[0].event_id) : null;
    const lastEventId = events.length ? String(events[events.length - 1].event_id) : null;
    req.ctx.audit!.outputDigest = { ok, checkedCount, failuresCount: failures.length, lastEventHash: prevHash };
    return { ok, checkedCount, firstEventId, lastEventId, lastEventHash: prevHash, failures };
  });

  app.get("/audit/retention", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "retention.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "retention.read" });
    const subject = req.ctx.subject!;
    const current = await getAuditRetentionPolicy({ pool: app.db, tenantId: subject.tenantId });
    const retentionDays = current?.retentionDays ?? 0;
    const out = { tenantId: subject.tenantId, retentionDays, updatedAt: current?.updatedAt ?? null };
    req.ctx.audit!.outputDigest = out;
    return out;
  });

  app.put("/audit/retention", async (req) => {
    const body = z.object({ retentionDays: z.number().int().min(0).max(36500) }).parse(req.body);
    setAuditContext(req, { resourceType: "audit", action: "retention.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "retention.update" });
    const subject = req.ctx.subject!;
    const row = await upsertAuditRetentionPolicy({ pool: app.db, tenantId: subject.tenantId, retentionDays: body.retentionDays });
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { tenantId: row.tenantId, retentionDays: row.retentionDays };
    return { tenantId: row.tenantId, retentionDays: row.retentionDays, updatedAt: row.updatedAt };
  });

  app.get("/audit/legal-holds", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "legalHold.manage" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "legalHold.manage" });
    const subject = req.ctx.subject!;
    const q = z.object({ status: z.enum(["active", "released"]).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    const items = await listAuditLegalHolds({ pool: app.db, tenantId: subject.tenantId, status: q.status, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/audit/legal-holds", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        subjectId: z.string().optional(),
        traceId: z.string().optional(),
        runId: z.string().optional(),
        reason: z.string().min(1).max(500),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "audit", action: "legalHold.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "legalHold.manage" });
    const subject = req.ctx.subject!;
    const scopeId = body.scopeType === "tenant" ? subject.tenantId : body.scopeId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");
    const hold = await createAuditLegalHold({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: body.scopeType,
      scopeId,
      fromTs: body.from ?? null,
      toTs: body.to ?? null,
      subjectId: body.subjectId ?? null,
      traceId: body.traceId ?? null,
      runId: body.runId ?? null,
      reason: body.reason,
      createdBy: subject.subjectId,
    });
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { holdId: hold.holdId, scopeType: hold.scopeType, status: hold.status };
    return { hold };
  });

  app.post("/audit/legal-holds/:holdId/release", async (req) => {
    const params = z.object({ holdId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "audit", action: "legalHold.release" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "legalHold.manage" });
    const subject = req.ctx.subject!;
    const current = await getAuditLegalHold({ pool: app.db, tenantId: subject.tenantId, holdId: params.holdId });
    if (!current) throw Errors.badRequest("Hold 不存在");
    const released = await releaseAuditLegalHold({ pool: app.db, tenantId: subject.tenantId, holdId: params.holdId, releasedBy: subject.subjectId });
    if (!released) throw Errors.badRequest("Hold 不可释放");
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { holdId: released.holdId, status: released.status };
    return { hold: released };
  });

  app.get("/audit/exports", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "export" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "export" });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const items = await listAuditExports({ pool: app.db, tenantId: subject.tenantId, limit });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/audit/exports/:exportId", async (req) => {
    const params = z.object({ exportId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "audit", action: "export" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "export" });
    const subject = req.ctx.subject!;
    const out = await getAuditExport({ pool: app.db, tenantId: subject.tenantId, exportId: params.exportId });
    if (!out) throw Errors.badRequest("Export 不存在");
    req.ctx.audit!.outputDigest = { exportId: out.exportId, status: out.status, hasArtifact: Boolean(out.artifactId) };
    return { export: out };
  });

  app.post("/audit/exports", async (req) => {
    const body = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        spaceId: z.string().optional(),
        subjectId: z.string().optional(),
        action: z.string().optional(),
        toolRef: z.string().optional(),
        workflowRef: z.string().optional(),
        traceId: z.string().optional(),
        limit: z.number().int().positive().max(50000).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "audit", action: "export.requested" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "export" });
    const subject = req.ctx.subject!;
    const filters = { ...body, requestedAt: new Date().toISOString() };
    const exp = await createAuditExport({ pool: app.db, tenantId: subject.tenantId, createdBy: subject.subjectId, filters });
    await app.queue.add(
      "step",
      { kind: "audit.export", exportId: exp.exportId, tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } },
    );
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { exportId: exp.exportId, status: exp.status };
    return { export: exp };
  });

  app.get("/audit/siem-destinations", async (req) => {
    setAuditContext(req, { resourceType: "audit", action: "siem.destination.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.destination.read" });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const items0 = await listAuditSiemDestinations({ pool: app.db, tenantId: subject.tenantId, limit });
    const items = await Promise.all(
      items0.map(async (it) => {
        const gov = await getSiemDestinationGovernanceExtras(app, subject.tenantId, it.id);
        return { ...it, ...gov };
      }),
    );
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.post("/audit/siem-destinations", async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(100),
        secretId: z.string().uuid(),
        enabled: z.boolean().optional(),
        batchSize: z.number().int().positive().max(1000).optional(),
        timeoutMs: z.number().int().positive().max(30000).optional(),
        maxAttempts: z.number().int().positive().max(50).optional(),
        backoffMsBase: z.number().int().min(0).max(60000).optional(),
        dlqThreshold: z.number().int().positive().max(50).optional(),
        alertThreshold: z.number().int().positive().max(100).optional(),
        alertEnabled: z.boolean().optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "audit", action: "siem.destination.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.destination.write" });
    const highRiskErr = requireHighRiskContext(req, body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const sec = await getSecretRecord(app.db, subject.tenantId, body.secretId);
    if (!sec) throw Errors.badRequest("Secret 不存在");
    if (sec.status !== "active") throw Errors.badRequest("Secret 未激活");

    const dest = await createAuditSiemDestination({
      pool: app.db,
      tenantId: subject.tenantId,
      name: body.name,
      enabled: body.enabled ?? false,
      secretId: body.secretId,
      batchSize: body.batchSize ?? 200,
      timeoutMs: body.timeoutMs ?? 5000,
    });
    await updateSiemDestinationGovernanceExtras(app, {
      tenantId: subject.tenantId,
      destinationId: dest.id,
      maxAttempts: body.maxAttempts,
      backoffMsBase: body.backoffMsBase,
      dlqThreshold: body.dlqThreshold,
      alertThreshold: body.alertThreshold,
      alertEnabled: body.alertEnabled,
    });
    const gov = await getSiemDestinationGovernanceExtras(app, subject.tenantId, dest.id);
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { destinationId: dest.id, enabled: dest.enabled };
    return { destination: { ...dest, ...gov } };
  });

  app.put("/audit/siem-destinations", async (req, reply) => {
    const body = z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        secretId: z.string().uuid().optional(),
        enabled: z.boolean().optional(),
        batchSize: z.number().int().positive().max(1000).optional(),
        timeoutMs: z.number().int().positive().max(30000).optional(),
        maxAttempts: z.number().int().positive().max(50).optional(),
        backoffMsBase: z.number().int().min(0).max(60000).optional(),
        dlqThreshold: z.number().int().positive().max(50).optional(),
        alertThreshold: z.number().int().positive().max(100).optional(),
        alertEnabled: z.boolean().optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "audit", action: "siem.destination.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.destination.write" });
    const highRiskErr = requireHighRiskContext(req, body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const cur = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: body.id });
    if (!cur) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Destination 不存在", "en-US": "Destination not found" }, traceId: req.ctx.traceId });

    const nextSecretId = body.secretId ?? cur.secretId;
    if (body.secretId) {
      const sec = await getSecretRecord(app.db, subject.tenantId, nextSecretId);
      if (!sec) throw Errors.badRequest("Secret 不存在");
      if (sec.status !== "active") throw Errors.badRequest("Secret 未激活");
    }

    const dest = await updateAuditSiemDestination({
      pool: app.db,
      tenantId: subject.tenantId,
      id: body.id,
      name: body.name ?? cur.name,
      enabled: body.enabled ?? cur.enabled,
      secretId: nextSecretId,
      batchSize: body.batchSize ?? cur.batchSize,
      timeoutMs: body.timeoutMs ?? cur.timeoutMs,
    });
    if (!dest) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Destination 不存在", "en-US": "Destination not found" }, traceId: req.ctx.traceId });
    await updateSiemDestinationGovernanceExtras(app, {
      tenantId: subject.tenantId,
      destinationId: dest.id,
      maxAttempts: body.maxAttempts,
      backoffMsBase: body.backoffMsBase,
      dlqThreshold: body.dlqThreshold,
      alertThreshold: body.alertThreshold,
      alertEnabled: body.alertEnabled,
    });
    const gov = await getSiemDestinationGovernanceExtras(app, subject.tenantId, dest.id);
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { destinationId: dest.id, enabled: dest.enabled };
    return { destination: { ...dest, ...gov } };
  });

  app.post("/audit/siem-destinations/:id/test", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "audit", action: "siem.destination.test" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.destination.test" });
    const highRiskErr = requireHighRiskContext(req, req.body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const dest = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!dest) throw Errors.badRequest("Destination 不存在");

    const secret = await getSecretRecordEncryptedPayload(app.db, subject.tenantId, dest.secretId);
    if (!secret) throw Errors.badRequest("Secret 不存在");
    if (secret.secret.status !== "active") throw Errors.badRequest("Secret 未激活");

    let decrypted: any;
    try {
      decrypted = await decryptSecretPayload({
        pool: app.db,
        tenantId: subject.tenantId,
        masterKey: masterKey(),
        scopeType: secret.secret.scopeType,
        scopeId: secret.secret.scopeId,
        keyVersion: secret.secret.keyVersion,
        encFormat: secret.secret.encFormat,
        encryptedPayload: secret.encryptedPayload,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg === "key_disabled") throw Errors.keyDisabled();
      throw Errors.keyDecryptFailed();
    }

    const payloadObj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
    const webhookUrl = typeof payloadObj.webhookUrl === "string" ? payloadObj.webhookUrl : "";
    if (!webhookUrl) throw Errors.badRequest("Secret payload 缺少 webhookUrl");
    const url = new URL(webhookUrl);
    const inst = await getConnectorInstance(app.db, subject.tenantId, secret.secret.connectorInstanceId);
    const type = inst ? await getConnectorType(app.db, inst.typeName) : null;
    const allowedDomains = getAllowedDomains({ connectorEgressPolicy: inst?.egressPolicy, typeDefaultEgressPolicy: type?.defaultEgressPolicy });
    if (!allowedDomains.includes(url.hostname)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      normalizeAuditErrorCategoryInRequest(req);
      throw Errors.badRequest(`egress denied: ${url.hostname}`);
    }

    const deliveryId = crypto.randomUUID();
    const sample = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      tenantId: subject.tenantId,
      resourceType: "audit",
      action: "siem.destination.test",
      result: "success",
      traceId: req.ctx.traceId,
      eventHash: null,
      prevHash: null,
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), dest.timeoutMs);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-audit-tenant-id": subject.tenantId,
          "x-audit-delivery-id": deliveryId,
        },
        body: `${JSON.stringify(sample)}\n`,
        signal: ctrl.signal,
      });
      req.ctx.audit!.outputDigest = { destinationId: dest.id, httpStatus: res.status };
      normalizeAuditErrorCategoryInRequest(req);
      return { ok: res.ok, httpStatus: res.status, deliveryId };
    } catch (e: any) {
      const isTimeout = String(e?.name ?? "") === "AbortError";
      req.ctx.audit!.errorCategory = "upstream_error";
      normalizeAuditErrorCategoryInRequest(req);
      req.ctx.audit!.outputDigest = { destinationId: dest.id, error: isTimeout ? "timeout" : "fetch_failed" };
      return { ok: false, httpStatus: null, deliveryId, errorCode: isTimeout ? "TIMEOUT" : "FETCH_FAILED", traceId: req.ctx.traceId };
    } finally {
      clearTimeout(t);
    }
  });

  app.post("/audit/siem-destinations/:id/backfill", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        fromTimestamp: z.string().optional(),
        fromEventId: z.string().uuid().optional(),
        clearOutbox: z.boolean().optional(),
        maxAttempts: z.number().int().positive().max(50).optional(),
        backoffMsBase: z.number().int().min(0).max(60000).optional(),
        dlqThreshold: z.number().int().positive().max(50).optional(),
        alertThreshold: z.number().int().positive().max(100).optional(),
        alertEnabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    setAuditContext(req, { resourceType: "audit", action: "siem.destination.backfill" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.destination.backfill" });
    const highRiskErr = requireHighRiskContext(req, body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const dest = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!dest) throw Errors.badRequest("Destination 不存在");

    if (body.clearOutbox ?? true) {
      await clearAuditSiemOutbox({ pool: app.db, tenantId: subject.tenantId, destinationId: dest.id });
    }
    await upsertAuditSiemCursor({
      pool: app.db,
      tenantId: subject.tenantId,
      destinationId: dest.id,
      lastTs: body.fromTimestamp ?? null,
      lastEventId: body.fromEventId ?? null,
    });
    await updateSiemDestinationGovernanceExtras(app, {
      tenantId: subject.tenantId,
      destinationId: dest.id,
      maxAttempts: body.maxAttempts,
      backoffMsBase: body.backoffMsBase,
      dlqThreshold: body.dlqThreshold,
      alertThreshold: body.alertThreshold,
      alertEnabled: body.alertEnabled,
    });
    const gov = await getSiemDestinationGovernanceExtras(app, subject.tenantId, dest.id);
    const dlq = await app.db.query("SELECT COUNT(*)::int AS c FROM audit_siem_dlq WHERE tenant_id = $1 AND destination_id = $2", [subject.tenantId, dest.id]);
    const dlqCount = Number(dlq.rows[0]?.c ?? 0);
    const alertThreshold = Number(gov?.alertThreshold ?? 3);
    const alertEnabled = Boolean(gov?.alertEnabled ?? true);
    const alertTriggered = alertEnabled && dlqCount >= alertThreshold;
    if (alertTriggered) {
      const digest = { reason: "dlq_threshold_reached", dlqCount, alertThreshold };
      try {
        await app.db.query(
          "UPDATE audit_siem_destinations SET last_alert_at = now(), last_alert_digest = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2",
          [subject.tenantId, dest.id, JSON.stringify(digest)],
        );
      } catch {
      }
    }
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { destinationId: dest.id, cleared: body.clearOutbox ?? true, dlqCount, alertTriggered };
    return { ok: true, destination: { ...dest, ...(await getSiemDestinationGovernanceExtras(app, subject.tenantId, dest.id)) }, alertTriggered, dlqCount };
  });

  app.get("/audit/siem-destinations/:id/dlq", async (req) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "audit", action: "siem.dlq.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.dlq.read" });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;

    const dest = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!dest) throw Errors.badRequest("Destination 不存在");

    const items = await listAuditSiemDlq({ pool: app.db, tenantId: subject.tenantId, destinationId: dest.id, limit });
    req.ctx.audit!.outputDigest = { destinationId: dest.id, count: items.length };
    return { items };
  });

  app.post("/audit/siem-destinations/:id/dlq/clear", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "audit", action: "siem.dlq.clear" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.dlq.write" });
    const highRiskErr = requireHighRiskContext(req, req.body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const dest = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!dest) throw Errors.badRequest("Destination 不存在");

    const out = await clearAuditSiemDlq({ pool: app.db, tenantId: subject.tenantId, destinationId: dest.id });
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { destinationId: dest.id, deletedCount: out.deletedCount };
    return { ok: true, deletedCount: out.deletedCount };
  });

  app.post("/audit/siem-destinations/:id/dlq/requeue", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ limit: z.number().int().positive().max(1000).optional() }).parse(req.body ?? {});
    setAuditContext(req, { resourceType: "audit", action: "siem.dlq.requeue" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "audit", action: "siem.dlq.write" });
    const highRiskErr = requireHighRiskContext(req, body);
    if (highRiskErr) return reply.status(409).send(highRiskErr);
    const subject = req.ctx.subject!;

    const dest = await getAuditSiemDestination({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!dest) throw Errors.badRequest("Destination 不存在");

    const out = await requeueAuditSiemDlq({ pool: app.db, tenantId: subject.tenantId, destinationId: dest.id, limit: body.limit ?? 200 });
    normalizeAuditErrorCategoryInRequest(req);
    req.ctx.audit!.outputDigest = { destinationId: dest.id, requeuedCount: out.requeuedCount };
    return { ok: true, requeuedCount: out.requeuedCount };
  });
};
