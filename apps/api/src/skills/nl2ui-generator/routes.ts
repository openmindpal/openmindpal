import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { generateUiFromNaturalLanguage } from "./modules/generator";
import { nl2uiRequestSchema, type Nl2UiGeneratedConfig } from "./modules/types";
import { upsertDraft, publishFromDraft } from "../ui-page-config/modules/pageRepo";
import type { PageDraft } from "../ui-page-config/modules/pageModel";


/**
 * NL2UI Routes - Natural Language to UI Generation API
 */
export const nl2uiRoutes: FastifyPluginAsync = async (app) => {
  
  /**
   * POST /nl2ui/generate
   * 从自然语言生成 UI 配置
   */
  app.post("/nl2ui/generate", async (req, reply) => {
    // 权限检查：需要 nl2ui.generate 权限
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "nl2ui", 
      action: "generate" 
    });
    
    const subject = req.ctx.subject!;
    
    // 验证请求
    const request = nl2uiRequestSchema.parse(req.body);
    
    try {
      // 调用生成器
      const config = await generateUiFromNaturalLanguage(app.db, {
        userInput: request.userInput,
        context: {
          userId: subject.subjectId || "anonymous",
          tenantId: subject.tenantId,
          spaceId: subject.spaceId || undefined,
        },
        stylePrefs: request.stylePrefs,
        previousConfig: request.previousConfig,
      }, {
        app,
        authorization: (req.headers.authorization as string | undefined) ?? "",
        traceId: req.ctx.traceId,
      });

      if (!config) {
        req.ctx.audit!.resourceType = "nl2ui_generation";
        req.ctx.audit!.action = "generate";
        req.ctx.audit!.outputDigest = { success: false };
        return { success: false };
      }
      
      // 审计日志
      req.ctx.audit!.resourceType = "nl2ui_generation";
      req.ctx.audit!.action = "generate";
      req.ctx.audit!.outputDigest = {
        confidence: config.metadata.confidence,
      };
      
      return {
        success: true,
        config,
        replyText: config.replyText || "好的，已为你生成界面。",
        suggestions: config.suggestions || [],
      };
    } catch (error: any) {
      if (error && typeof error === "object" && error.statusCode === 429) {
        const payload = (error as any).payload;
        return reply.status(429).send(payload ?? { errorCode: "RATE_LIMITED", message: { "zh-CN": "请求过于频繁", "en-US": "Too many requests" }, traceId: req.ctx.traceId });
      }
      if (error && typeof error === "object" && error.payload && typeof error.payload === "object" && typeof error.statusCode === "number") {
        return reply.status(error.statusCode).send(error.payload);
      }

      console.error("NL2UI generation error:", error?.message ?? error, error?.stack);
      
      req.ctx.audit!.resourceType = "nl2ui_generation";
      req.ctx.audit!.action = "generate";
      req.ctx.audit!.outputDigest = { error: error?.message ?? "unknown" };

      // 大模型生成失败，直接返回失败状态，不降级到关键词规则引擎
      return {
        success: false,
        error: "界面生成失败，大模型服务暂时不可用，请稍后再试",
        detail: error?.message ?? "unknown",
      };
    }
  });
  
  /**
   * GET /nl2ui/style-preferences
   * 获取用户的样式偏好设置
   */
  app.get("/nl2ui/style-preferences", async (req) => {
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "nl2ui", 
      action: "read_preferences" 
    });
    
    const subject = req.ctx.subject!;
    
    const res = await app.db.query(
      `SELECT pref_value FROM memory_user_preferences 
       WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'nl2ui.style_prefs'
       LIMIT 1`,
      [subject.tenantId, subject.subjectId]
    );
    
    if (!res.rowCount || !res.rows[0]) {
      return { preferences: null };
    }
    
    return { preferences: res.rows[0].pref_value };
  });
  
  /**
   * PUT /nl2ui/style-preferences
   * 更新用户的样式偏好
   */
  app.put("/nl2ui/style-preferences", async (req) => {
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "nl2ui", 
      action: "write_preferences" 
    });
    
    const subject = req.ctx.subject!;
    
    const body = z.object({
      fontSize: z.enum(["small", "medium", "large"]).optional(),
      cardStyle: z.enum(["minimal", "modern", "classic"]).optional(),
      colorTheme: z.enum(["blue", "green", "warm", "dark"]).optional(),
      density: z.enum(["compact", "comfortable"]).optional(),
      defaultLayout: z.enum(["list", "cards", "kanban", "table"]).optional(),
    }).parse(req.body);
    
    await app.db.query(
      `INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
       VALUES ($1, $2, 'nl2ui.style_prefs', $3::jsonb, NOW())
       ON CONFLICT (tenant_id, subject_id, pref_key)
       DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = NOW()`,
      [subject.tenantId, subject.subjectId, JSON.stringify(body)]
    );
    
    req.ctx.audit!.resourceType = "nl2ui_preferences";
    req.ctx.audit!.action = "update";
    req.ctx.audit!.outputDigest = { preferences: body };
    
    return { success: true, preferences: body };
  });
  
  /**
   * POST /nl2ui/save-page
   * 将 NL2UI 生成的配置保存为 PageTemplate
   */
  app.post("/nl2ui/save-page", async (req) => {
    setAuditContext(req, { resourceType: "nl2ui_page", action: "save" });
    req.ctx.audit!.policyDecision = await requirePermission({
      req,
      resourceType: "ui_config",
      action: "write",
    });

    const subject = req.ctx.subject!;
    const body = z.object({
      config: z.any(),
      pageName: z.string().min(1).max(120).optional(),
      title: z.string().min(1).max(200).optional(),
      autoPublish: z.boolean().optional(),
    }).parse(req.body);

    const config = body.config as Nl2UiGeneratedConfig;
    if (!config?.ui?.layout) {
      throw Errors.badRequest("config.ui.layout is required");
    }

    // Derive page name from dataBindings or layout areas
    const primaryEntity = config.dataBindings?.[0]?.params?.entityName
      || config.ui.layout.areas?.[0]?.props?.entityName
      || "page";
    const timestamp = Date.now().toString(36);
    const pageName = body.pageName || `nl2ui.${primaryEntity}.${timestamp}`;

    // Derive title
    const title = body.title
      || config.ui.layout.areas?.[0]?.props?.title
      || `NL2UI - ${primaryEntity}`;

    // Convert NL2UI config to PageDraft format
    // 从 actionBindings 或 layout 推导 pageType，不再硬编码 intent 映射
    const hasWriteAction = config.actionBindings?.some((a) => a.action === "create" || a.action === "update");
    const pageType = hasWriteAction ? "entity.edit" : "entity.list";

    // Convert NL2UI dataBindings → page dataBindings
    const pageDataBindings: Array<{ target: "entities.list"; entityName: string }> = [];
    if (Array.isArray(config.dataBindings)) {
      for (const db of config.dataBindings) {
        const entityName = db.params?.entityName || primaryEntity;
        pageDataBindings.push({ target: "entities.list", entityName });
      }
    }
    if (pageDataBindings.length === 0) {
      pageDataBindings.push({ target: "entities.list", entityName: primaryEntity });
    }

    // Convert NL2UI layout areas → page ui blocks
    const pageBlocks: Array<{ slot: string; componentId: string; props: Record<string, any> }> = [];
    if (Array.isArray(config.ui.layout.areas)) {
      for (const area of config.ui.layout.areas) {
        pageBlocks.push({
          slot: area.name || "content",
          componentId: area.componentId || "EntityList.Table",
          props: area.props || {},
        });
      }
    }

    const draft: PageDraft = {
      pageType: pageType as any,
      title: { "zh-CN": title, "en-US": title },
      params: { entityName: primaryEntity, nl2uiConfig: config },
      dataBindings: pageDataBindings,
      ui: {
        layout: { variant: config.ui.layout.variant || "single" },
        blocks: pageBlocks.length > 0 ? pageBlocks : undefined,
      },
    };

    // Resolve scope
    const scopeType = subject.spaceId ? "space" : "tenant";
    const scopeId = subject.spaceId || subject.tenantId;
    const key = { tenantId: subject.tenantId, scopeType: scopeType as "space" | "tenant", scopeId, name: pageName };

    // Save draft
    const saved = await upsertDraft(app.db, key, draft);

    // Auto-publish if requested
    let released = null;
    if (body.autoPublish !== false) {
      try {
        released = await publishFromDraft(app.db, key);
      } catch {
        // publish failure is non-fatal
      }
    }

    req.ctx.audit!.outputDigest = { pageName, pageType, primaryEntity, published: !!released };

    return {
      success: true,
      pageName,
      pageUrl: `/p/${encodeURIComponent(pageName)}`,
      draft: saved,
      released,
    };
  });

  /**
   * DELETE /nl2ui/style-preferences
   * 清除用户的样式偏好
   */
  app.delete("/nl2ui/style-preferences", async (req) => {
    req.ctx.audit!.policyDecision = await requirePermission({ 
      req, 
      resourceType: "nl2ui", 
      action: "delete_preferences" 
    });
    
    const subject = req.ctx.subject!;
    
    await app.db.query(
      `DELETE FROM memory_user_preferences 
       WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'nl2ui.style_prefs'`,
      [subject.tenantId, subject.subjectId]
    );
    
    req.ctx.audit!.resourceType = "nl2ui_preferences";
    req.ctx.audit!.action = "delete";
    
    return { success: true };
  });
};
