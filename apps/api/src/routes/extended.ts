import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import {
  transitionSkillStatus,
  listSkillLifecycleEvents,
  getSkillStatusSummary,
  isSkillEnabled,
  getRequiredApprovalLevel,
} from "../modules/governance/skillLifecycleRepo";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

export const skillLifecycleRoutes: FastifyPluginAsync = async (app) => {
  // ─── Skill Lifecycle ────────────────────────────────────────────────
  app.get("/skill-lifecycle/summary", async (req) => {
    setAuditContext(req, { resourceType: "skill_lifecycle", action: "summary" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const summary = await getSkillStatusSummary({ pool: app.db, tenantId: subject.tenantId });
    return { summary };
  });

  app.get("/skill-lifecycle/events", async (req) => {
    setAuditContext(req, { resourceType: "skill_lifecycle", action: "list_events" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const query = z.object({
      skillName: z.string().optional(),
      scopeType: z.enum(["user", "space", "tenant"]).optional(),
      limit: z.coerce.number().min(1).max(500).optional(),
    }).parse(req.query);
    const events = await listSkillLifecycleEvents({ pool: app.db, tenantId: subject.tenantId, ...query });
    return { events };
  });

  app.post("/skill-lifecycle/transition", async (req) => {
    setAuditContext(req, { resourceType: "skill_lifecycle", action: "transition" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z.object({
      skillName: z.string().min(1),
      skillVersion: z.string().optional(),
      toStatus: z.enum(["draft", "enabled_user_scope", "enabled_space", "enabled_tenant", "disabled", "revoked"]),
      scopeType: z.enum(["user", "space", "tenant"]).optional(),
      scopeId: z.string().optional(),
      approvalId: z.string().optional(),
      reason: z.string().optional(),
    }).parse(req.body);

    const requiredApproval = getRequiredApprovalLevel(body.toStatus);
    const event = await transitionSkillStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: body.skillName,
      skillVersion: body.skillVersion,
      toStatus: body.toStatus,
      scopeType: body.scopeType ?? scope.scopeType === "space" ? "space" : "tenant",
      scopeId: body.scopeId ?? scope.scopeId,
      changedBy: subject.subjectId,
      approvalId: body.approvalId,
      reason: body.reason,
    });
    req.ctx.audit!.outputDigest = { eventId: event.eventId, requiredApproval };
    return { event, requiredApproval };
  });

  app.get("/skill-lifecycle/check/:skillName", async (req) => {
    const params = z.object({ skillName: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "skill_lifecycle", action: "check" });
    await requirePermission({ req, resourceType: "skill", action: "read" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const result = await isSkillEnabled({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.skillName,
      scopeType: scope.scopeType === "space" ? "space" : "tenant",
      scopeId: scope.scopeId,
      subjectId: subject.subjectId,
    });
    return result;
  });
};
