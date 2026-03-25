/**
 * AI Event Reasoning Skill — HTTP Routes.
 *
 * Provides governance API for:
 * - Reasoning rules CRUD (Tier1/Tier2 configuration)
 * - Manual event reasoning trigger
 * - Reasoning logs query (observability)
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import {
  listAllRules,
  getRule,
  createRule,
  updateRule,
  listReasoningLogs,
  getReasoningLog,
} from "./modules/reasoningRepo";
import { reasonAboutEvent, type EventEnvelope } from "./modules/eventReasoning";

export const aiEventReasoningRoutes: FastifyPluginAsync = async (app) => {
  /* ────────────────── Rules CRUD ────────────────── */

  /** List reasoning rules */
  app.get("/governance/event-reasoning/rules", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_rule", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_rule", action: "read" });
    const subject = requireSubject(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    const items = await listAllRules({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 100 });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  /** Get a single rule */
  app.get("/governance/event-reasoning/rules/:ruleId", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_rule", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_rule", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    const rule = await getRule({ pool: app.db, tenantId: subject.tenantId, ruleId: params.ruleId });
    if (!rule) throw Errors.notFound("event_reasoning_rule");
    req.ctx.audit!.outputDigest = { ruleId: rule.ruleId, name: rule.name };
    return { rule };
  });

  /** Create a reasoning rule */
  app.post("/governance/event-reasoning/rules", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_rule", action: "manage" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_rule", action: "manage" });
    const subject = requireSubject(req);

    const body = z
      .object({
        spaceId: z.string().min(1).optional(),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        tier: z.enum(["rule", "pattern"]),
        priority: z.number().int().min(0).max(10000).optional(),
        eventTypePattern: z.string().max(500).optional(),
        providerPattern: z.string().max(500).optional(),
        conditionExpr: z.any().optional(),
        decision: z.enum(["execute", "escalate", "ignore"]),
        actionKind: z.enum(["workflow", "notify", "tool"]).optional(),
        actionRef: z.string().max(500).optional(),
        actionInputTemplate: z.any().optional(),
      })
      .parse(req.body);

    // Validate: if decision is execute, actionKind/actionRef are required
    if (body.decision === "execute") {
      if (!body.actionKind) throw Errors.badRequest("decision 为 execute 时必须指定 actionKind");
      if (!body.actionRef) throw Errors.badRequest("decision 为 execute 时必须指定 actionRef");
    }

    const rule = await createRule({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: body.spaceId ?? null,
      name: body.name,
      description: body.description ?? null,
      tier: body.tier,
      priority: body.priority ?? 100,
      eventTypePattern: body.eventTypePattern ?? null,
      providerPattern: body.providerPattern ?? null,
      conditionExpr: body.conditionExpr ?? null,
      decision: body.decision,
      actionKind: body.actionKind ?? null,
      actionRef: body.actionRef ?? null,
      actionInputTemplate: body.actionInputTemplate ?? null,
      createdBySubjectId: subject.subjectId,
    });

    req.ctx.audit!.outputDigest = { ruleId: rule.ruleId, name: rule.name, tier: rule.tier, decision: rule.decision };
    return { rule };
  });

  /** Update a reasoning rule */
  app.post("/governance/event-reasoning/rules/:ruleId/update", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_rule", action: "manage" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_rule", action: "manage" });
    const subject = requireSubject(req);
    const params = z.object({ ruleId: z.string().uuid() }).parse(req.params);

    const body = z
      .object({
        status: z.enum(["enabled", "disabled"]).optional(),
        description: z.string().max(2000).optional(),
        priority: z.number().int().min(0).max(10000).optional(),
        eventTypePattern: z.string().max(500).optional(),
        providerPattern: z.string().max(500).optional(),
        conditionExpr: z.any().optional(),
        decision: z.enum(["execute", "escalate", "ignore"]).optional(),
        actionKind: z.enum(["workflow", "notify", "tool"]).optional(),
        actionRef: z.string().max(500).optional(),
        actionInputTemplate: z.any().optional(),
      })
      .parse(req.body);

    const updated = await updateRule({
      pool: app.db,
      tenantId: subject.tenantId,
      ruleId: params.ruleId,
      patch: body,
    });
    if (!updated) throw Errors.notFound("event_reasoning_rule");

    req.ctx.audit!.outputDigest = { ruleId: updated.ruleId, status: updated.status };
    return { rule: updated };
  });

  /* ────────────────── Manual Reasoning Trigger ────────────────── */

  /** Manually submit an event for AI reasoning (supports all 3 tiers) */
  app.post("/governance/event-reasoning/reason", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning", action: "fire" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning", action: "fire" });
    const subject = requireSubject(req);

    const body = z
      .object({
        eventType: z.string().min(1).max(500),
        provider: z.string().max(200).optional(),
        workspaceId: z.string().max(200).optional(),
        spaceId: z.string().min(1).optional(),
        payload: z.any().optional(),
        /** Max tier to escalate to: 'rule' (Tier1 only), 'pattern' (T1+T2), 'llm' (all) */
        maxTier: z.enum(["rule", "pattern", "llm"]).optional(),
      })
      .parse(req.body);

    const event: EventEnvelope = {
      eventSourceId: `manual:${crypto.randomUUID()}`,
      eventType: body.eventType,
      provider: body.provider ?? null,
      workspaceId: body.workspaceId ?? null,
      spaceId: body.spaceId ?? subject.spaceId ?? null,
      payload: body.payload ?? null,
    };

    const decision = await reasonAboutEvent(
      {
        app,
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: event.spaceId,
        subjectId: subject.subjectId,
        traceId: req.ctx.traceId,
      },
      event,
    );

    req.ctx.audit!.outputDigest = {
      tier: decision.tier,
      decision: decision.decision,
      latencyMs: decision.latencyMs,
      actionKind: decision.actionKind,
      actionRef: decision.actionRef,
    };

    return { decision };
  });

  /* ────────────────── Reasoning Logs (Observability) ────────────────── */

  /** List reasoning decision logs */
  app.get("/governance/event-reasoning/logs", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_log", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_log", action: "read" });
    const subject = requireSubject(req);
    const q = z.object({
      limit: z.coerce.number().int().positive().max(200).optional(),
      decision: z.enum(["execute", "escalate", "ignore", "error"]).optional(),
    }).parse(req.query);
    const items = await listReasoningLogs({ pool: app.db, tenantId: subject.tenantId, limit: q.limit ?? 50, decision: q.decision });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  /** Get a single reasoning log */
  app.get("/governance/event-reasoning/logs/:reasoningId", async (req) => {
    setAuditContext(req, { resourceType: "event_reasoning_log", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "event_reasoning_log", action: "read" });
    const subject = requireSubject(req);
    const params = z.object({ reasoningId: z.string().uuid() }).parse(req.params);
    const log = await getReasoningLog({ pool: app.db, tenantId: subject.tenantId, reasoningId: params.reasoningId });
    if (!log) throw Errors.notFound("event_reasoning_log");
    req.ctx.audit!.outputDigest = { reasoningId: log.reasoningId, decision: log.decision };
    return { log };
  });
};
