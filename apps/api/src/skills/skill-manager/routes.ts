/**
 * Skill Manager Routes
 *
 * 提供技能管理的HTTP API：
 * - GET  /skill-manager/list          列出所有技能
 * - GET  /skill-manager/:name/status  获取技能状态
 * - POST /skill-manager/:name/enable  启用技能
 * - POST /skill-manager/:name/disable 禁用技能
 * - GET  /skill-manager/:name/config  获取技能配置
 * - POST /skill-manager/:name/config  修改技能配置
 * - POST /skill-manager/generate      生成技能草稿
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { getBuiltinSkills, type BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { Errors } from "../../lib/errors";

// ─── Type Definitions ─────────────────────────────────────────────────
interface SkillInfo {
  name: string;
  version: string;
  layer: string;
  displayName: Record<string, string> | null;
  description: Record<string, string> | null;
}

function getBuiltinSkillList(): SkillInfo[] {
  const skills = getBuiltinSkills();
  const result: SkillInfo[] = [];
  for (const [_, plugin] of skills) {
    result.push({
      name: plugin.manifest.identity.name,
      version: plugin.manifest.identity.version,
      layer: plugin.manifest.layer ?? "builtin",
      displayName: plugin.manifest.tools?.[0]?.displayName ?? null,
      description: plugin.manifest.tools?.[0]?.description ?? null,
    });
  }
  return result;
}
import {
  transitionSkillStatus,
  getLatestSkillStatus,
  getSkillStatusSummary,
  isSkillEnabled,
  type SkillLifecycleStatus,
  type SkillScopeType,
} from "../../modules/governance/skillLifecycleRepo";
import {
  getSkillConfig,
  setSkillConfig,
  listSkillConfigs,
} from "./modules/skillConfigRepo";
import {
  generateSkillCode,
  type SkillTemplateConfig,
  type SkillTemplateField,
} from "./modules/skillTemplateGenerator";
import {
  createSkillDraft,
  getSkillDraft,
  listSkillDrafts,
  updateSkillDraftCode,
  updateSkillDraftStatus,
  deleteSkillDraft,
} from "./modules/skillDraftRepo";
import {
  publishSkillDraft,
  listPublishedCustomSkills,
} from "./modules/skillDraftPublisher";
import {
  checkBeforeCreate,
  formatDuplicatePrompt,
} from "../../modules/skills/skillRouter";

// ─── Scope Helper ─────────────────────────────────────────────────────
function resolveScope(subject: { tenantId: string; spaceId?: string | null; subjectId: string }, requestedScope?: string): { scopeType: SkillScopeType; scopeId: string } {
  if (requestedScope === "user") return { scopeType: "user", scopeId: subject.subjectId };
  if (requestedScope === "tenant") return { scopeType: "tenant", scopeId: subject.tenantId };
  if (subject.spaceId) return { scopeType: "space", scopeId: subject.spaceId };
  return { scopeType: "tenant", scopeId: subject.tenantId };
}

// ─── Status to Enable Status Mapping ──────────────────────────────────
function getEnableStatus(scopeType: SkillScopeType): SkillLifecycleStatus {
  switch (scopeType) {
    case "user": return "enabled_user_scope";
    case "space": return "enabled_space";
    case "tenant": return "enabled_tenant";
    default: return "enabled_user_scope";
  }
}

export const skillManagerRoutes: FastifyPluginAsync = async (app) => {
  // ─── List all skills ─────────────────────────────────────────────────
  const listSkills = async (req: any) => {
    setAuditContext(req, { resourceType: "skill", action: "list" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);

    // Get builtin skills from registry
    const builtinSkills = getBuiltinSkillList();

    // Get lifecycle status for all skills
    const statusSummary = await getSkillStatusSummary({ pool: app.db, tenantId: subject.tenantId });
    const statusMap = new Map(statusSummary.map((s) => [s.skillName, s]));

    // Merge builtin list with status
    const skills = builtinSkills.map((skill) => {
      const status = statusMap.get(skill.name);
      return {
        name: skill.name,
        version: skill.version,
        layer: skill.layer ?? "builtin",
        displayName: skill.displayName,
        description: skill.description,
        status: status?.latestStatus ?? "enabled_tenant",
        scopeType: status?.scopeType ?? "tenant",
        updatedAt: status?.updatedAt ?? null,
      };
    });

    // Add any skills from status that aren't in builtin (extension skills)
    for (const [name, status] of statusMap) {
      if (!builtinSkills.some((s) => s.name === name)) {
        skills.push({
          name,
          version: "unknown",
          layer: "extension",
          displayName: null,
          description: null,
          status: status.latestStatus,
          scopeType: status.scopeType,
          updatedAt: status.updatedAt,
        });
      }
    }

    req.ctx.audit!.outputDigest = { count: skills.length };
    return { skills };
  };

  app.get("/skill-manager/list", listSkills);
  app.get("/skills", listSkills);

  // ─── Get skill status ────────────────────────────────────────────────
  app.get("/skill-manager/:name/status", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "skill", action: "read" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject);

    // Check if skill is enabled at this scope
    const enabledResult = await isSkillEnabled({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      subjectId: subject.subjectId,
    });

    // Get latest lifecycle event
    const latestEvent = await getLatestSkillStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
    });

    // Get builtin skill info if available
    const builtinSkills = getBuiltinSkillList();
    const builtinInfo = builtinSkills.find((s) => s.name === params.name);

    req.ctx.audit!.outputDigest = { skillName: params.name, enabled: enabledResult.enabled };
    return {
      skill: {
        name: params.name,
        version: builtinInfo?.version ?? "unknown",
        layer: builtinInfo?.layer ?? "extension",
        displayName: builtinInfo?.displayName ?? null,
        description: builtinInfo?.description ?? null,
      },
      enabled: enabledResult.enabled,
      status: enabledResult.status,
      scope: enabledResult.scope,
      latestEvent: latestEvent
        ? {
            eventId: latestEvent.eventId,
            fromStatus: latestEvent.fromStatus,
            toStatus: latestEvent.toStatus,
            changedBy: latestEvent.changedBy,
            reason: latestEvent.reason,
            createdAt: latestEvent.createdAt,
          }
        : null,
    };
  });

  app.get("/skills/:name", async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "skill", action: "read" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const plugin = getBuiltinSkills().get(params.name) as BuiltinSkillPlugin | undefined;
    if (!plugin) throw Errors.notFound("skill");
    return reply.send({ skill: plugin.manifest.identity });
  });

  // ─── Enable skill ────────────────────────────────────────────────────
  app.post("/skill-manager/:name/enable", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({
      scopeType: z.enum(["user", "space", "tenant"]).optional(),
      reason: z.string().max(500).optional(),
    }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "skill", action: "enable", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject, body.scopeType);
    const toStatus = getEnableStatus(scope.scopeType);

    const event = await transitionSkillStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      toStatus,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      changedBy: subject.subjectId,
      reason: body.reason ?? "通过对话启用",
    });

    req.ctx.audit!.outputDigest = { skillName: params.name, eventId: event.eventId, toStatus };
    return { success: true, event };
  });

  // ─── Disable skill ───────────────────────────────────────────────────
  app.post("/skill-manager/:name/disable", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({
      reason: z.string().max(500).optional(),
    }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "skill", action: "disable", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject);

    const event = await transitionSkillStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      toStatus: "disabled",
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      changedBy: subject.subjectId,
      reason: body.reason ?? "通过对话禁用",
    });

    req.ctx.audit!.outputDigest = { skillName: params.name, eventId: event.eventId, toStatus: "disabled" };
    return { success: true, event };
  });

  // ─── Get skill config ────────────────────────────────────────────────
  app.get("/skill-manager/:name/config", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "skill", action: "config.read" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject);

    const configs = await listSkillConfigs({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });

    // Convert to key-value object
    const config: Record<string, unknown> = {};
    for (const c of configs) {
      config[c.configKey] = c.configValue;
    }

    req.ctx.audit!.outputDigest = { skillName: params.name, configKeys: Object.keys(config) };
    return { skillName: params.name, config };
  });

  // ─── Set skill config ────────────────────────────────────────────────
  app.post("/skill-manager/:name/config", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({
      configKey: z.string().min(1).max(100),
      configValue: z.any(),
    }).parse(req.body);

    setAuditContext(req, { resourceType: "skill", action: "config.write", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const scope = resolveScope(subject);

    // Get previous value
    const previous = await getSkillConfig({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      configKey: body.configKey,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
    });

    // Set new value
    await setSkillConfig({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName: params.name,
      configKey: body.configKey,
      configValue: body.configValue,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      changedBy: subject.subjectId,
    });

    req.ctx.audit!.outputDigest = {
      skillName: params.name,
      configKey: body.configKey,
      previousValue: previous?.configValue ?? null,
    };
    return {
      success: true,
      skillName: params.name,
      configKey: body.configKey,
      previousValue: previous?.configValue ?? null,
    };
  });

  // ─── Generate skill draft (enhanced) ──────────────────────────────────
  app.post("/skill-manager/generate", async (req) => {
    const fieldSchema = z.object({
      name: z.string().min(1),
      type: z.enum(["string", "number", "boolean", "object", "array", "any"]),
      required: z.boolean().optional(),
      description: z.string().optional(),
    });

    const body = z.object({
      description: z.string().min(10).max(2000),
      skillName: z.string().min(1).max(100).optional(),
      displayName: z.object({
        "zh-CN": z.string(),
        "en-US": z.string(),
      }).optional(),
      inputFields: z.array(fieldSchema).optional(),
      outputFields: z.array(fieldSchema).optional(),
      riskLevel: z.enum(["low", "medium", "high"]).optional(),
      scope: z.enum(["read", "write"]).optional(),
      needsExternalApi: z.boolean().optional(),
      externalApiBaseUrl: z.string().optional(),
      saveDraft: z.boolean().optional(),
      forceCreate: z.boolean().optional(), // 跳过重复检测，强制创建
    }).parse(req.body);

    setAuditContext(req, { resourceType: "skill", action: "generate" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);

    // Generate skill name if not provided
    const skillName = body.skillName ?? `custom.skill.${Date.now()}`;

    // Check for duplicate/similar skills before creating
    const duplicateCheck = await checkBeforeCreate({
      pool: app.db,
      tenantId: subject.tenantId,
      skillName,
      description: body.description,
    });

    // If high similarity detected, return warning with similar skills (unless forceCreate)
    if (!body.forceCreate && !duplicateCheck.shouldCreate && duplicateCheck.recommendation === "reuse") {
      const locale = (req.headers["accept-language"] ?? "zh-CN").split(",")[0] ?? "zh-CN";
      return {
        warning: true,
        message: duplicateCheck.message,
        recommendation: duplicateCheck.recommendation,
        similarSkills: duplicateCheck.similar.map((s) => ({
          skillName: s.skillName,
          displayName: s.displayName,
          description: s.description,
          similarity: Math.round(s.similarity * 100),
        })),
        prompt: formatDuplicatePrompt(duplicateCheck, locale),
        // Still allow creation if user insists (by passing forceCreate=true)
        hint: { "zh-CN": "如确需创建，请添加 forceCreate: true", "en-US": "Add forceCreate: true to proceed" },
      };
    }

    // Build template config
    const config: SkillTemplateConfig = {
      skillName,
      displayName: body.displayName,
      description: {
        "zh-CN": body.description,
        "en-US": body.description,
      },
      inputFields: (body.inputFields ?? []) as SkillTemplateField[],
      outputFields: (body.outputFields ?? []) as SkillTemplateField[],
      riskLevel: body.riskLevel ?? "medium",
      scope: body.scope ?? "write",
      needsExternalApi: body.needsExternalApi,
      externalApiBaseUrl: body.externalApiBaseUrl,
    };

    // Generate code using template generator
    const generated = generateSkillCode(config);

    // Save draft if requested
    let draftId: string | null = null;
    if (body.saveDraft !== false) {
      const draft = await createSkillDraft({
        pool: app.db,
        tenantId: subject.tenantId,
        skillName,
        description: body.description,
        manifest: generated.manifest,
        indexCode: generated.indexTs,
        routesCode: generated.routesTs,
        createdBy: subject.subjectId,
      });
      draftId = draft.draftId;
    }

    req.ctx.audit!.outputDigest = { skillName, draftId, generated: true };
    return {
      draft: {
        draftId,
        skillName,
        description: body.description,
        status: "draft",
        createdBy: subject.subjectId,
        createdAt: new Date().toISOString(),
      },
      manifest: generated.manifest,
      code: {
        index: generated.indexTs,
        routes: generated.routesTs,
      },
    };
  });

  // ─── List drafts ──────────────────────────────────────────────────────
  app.get("/skill-manager/drafts", async (req) => {
    setAuditContext(req, { resourceType: "skill_draft", action: "list" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const query = z.object({
      status: z.enum(["draft", "reviewing", "approved", "rejected", "published"]).optional(),
      limit: z.coerce.number().min(1).max(200).optional(),
    }).parse(req.query);

    const drafts = await listSkillDrafts({
      pool: app.db,
      tenantId: subject.tenantId,
      createdBy: subject.subjectId,
      status: query.status,
      limit: query.limit,
    });

    req.ctx.audit!.outputDigest = { count: drafts.length };
    return { drafts };
  });

  // ─── Get draft ────────────────────────────────────────────────────────
  app.get("/skill-manager/drafts/:draftId", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "skill_draft", action: "read" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const draft = await getSkillDraft({
      pool: app.db,
      tenantId: subject.tenantId,
      draftId: params.draftId,
    });

    if (!draft) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "草稿不存在", "en-US": "Draft not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { draftId: draft.draftId, skillName: draft.skillName };
    return { draft };
  });

  // ─── Update draft code ────────────────────────────────────────────────
  app.patch("/skill-manager/drafts/:draftId", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      indexCode: z.string().optional(),
      routesCode: z.string().optional(),
    }).parse(req.body);

    setAuditContext(req, { resourceType: "skill_draft", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const draft = await updateSkillDraftCode({
      pool: app.db,
      tenantId: subject.tenantId,
      draftId: params.draftId,
      indexCode: body.indexCode,
      routesCode: body.routesCode,
    });

    if (!draft) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "草稿不存在", "en-US": "Draft not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { draftId: draft.draftId, updated: true };
    return { success: true, draft };
  });

  // ─── Submit draft for review ──────────────────────────────────────────
  app.post("/skill-manager/drafts/:draftId/submit", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "skill_draft", action: "submit", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const draft = await updateSkillDraftStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      draftId: params.draftId,
      status: "reviewing",
    });

    if (!draft) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "草稿不存在", "en-US": "Draft not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { draftId: draft.draftId, status: "reviewing" };
    return { success: true, draft };
  });

  // ─── Approve draft ────────────────────────────────────────────────────
  app.post("/skill-manager/drafts/:draftId/approve", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "skill_draft", action: "approve", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "approve" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const draft = await updateSkillDraftStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      draftId: params.draftId,
      status: "approved",
      approvedBy: subject.subjectId,
    });

    if (!draft) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "草稿不存在", "en-US": "Draft not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { draftId: draft.draftId, status: "approved", approvedBy: subject.subjectId };
    return { success: true, draft };
  });

  // ─── Delete draft ─────────────────────────────────────────────────────
  app.delete("/skill-manager/drafts/:draftId", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "skill_draft", action: "delete", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const deleted = await deleteSkillDraft({
      pool: app.db,
      tenantId: subject.tenantId,
      draftId: params.draftId,
    });

    if (!deleted) {
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "草稿不存在", "en-US": "Draft not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { draftId: params.draftId, deleted: true };
    return { success: true };
  });

  // ─── Publish draft (确认即生效) ─────────────────────────────────
  app.post("/skill-manager/drafts/:draftId/publish", async (req, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(req.params);

    setAuditContext(req, { resourceType: "skill_draft", action: "publish", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "skill", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) {
      return reply.status(400).send({
        errorCode: "BAD_REQUEST",
        message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" },
        traceId: req.ctx.traceId,
      });
    }

    try {
      const result = await publishSkillDraft({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        draftId: params.draftId,
        publishedBy: subject.subjectId,
      });

      req.ctx.audit!.outputDigest = {
        draftId: params.draftId,
        artifactId: result.artifactId,
        toolName: result.toolName,
        published: true,
      };
      return {
        success: true,
        message: { "zh-CN": "技能已发布，立即生效", "en-US": "Skill published and active" },
        artifactId: result.artifactId,
        toolName: result.toolName,
        depsDigest: result.depsDigest,
        publishedAt: result.publishedAt,
      };
    } catch (error: any) {
      return reply.status(400).send({
        errorCode: "PUBLISH_FAILED",
        message: { "zh-CN": error?.message ?? "发布失败", "en-US": error?.message ?? "Publish failed" },
        traceId: req.ctx.traceId,
      });
    }
  });

  // ─── List published custom skills (前端可见) ──────────────────────
  app.get("/skill-manager/custom-skills", async (req) => {
    setAuditContext(req, { resourceType: "skill", action: "list" });
    const decision = await requirePermission({ req, resourceType: "skill", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const query = z.object({
      limit: z.coerce.number().min(1).max(200).optional(),
    }).parse(req.query);

    const skills = await listPublishedCustomSkills({
      pool: app.db,
      tenantId: subject.tenantId,
      limit: query.limit,
    });

    req.ctx.audit!.outputDigest = { count: skills.length };
    return { skills };
  });
};
