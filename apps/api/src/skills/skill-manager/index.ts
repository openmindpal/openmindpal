/**
 * Skill Manager — 技能管理器
 *
 * 提供通过对话管理Skill的能力：
 * - skill.config: 查看/修改Skill配置
 * - skill.lifecycle: 启用/禁用/撤销Skill
 * - skill.list: 列出所有Skill及状态
 * - skill.generate: AI生成新Skill（草稿）
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { skillManagerRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "skill.manager", version: "1.0.0" },
    layer: "kernel", // 治理工具默认启用
    routes: ["/skill-manager"],
    dependencies: ["audit", "rbac"],
    tools: [
      // ─── skill.list ───────────────────────────────────────────────
      {
        name: "skill.list",
        displayName: { "zh-CN": "列出技能", "en-US": "List skills" },
        description: { "zh-CN": "列出所有已注册的技能及其状态", "en-US": "List all registered skills and their status" },
        scope: "read",
        resourceType: "skill",
        action: "list",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            scopeType: { type: "string", description: "作用域类型: user/space/tenant" },
          },
        },
        outputSchema: {
          fields: {
            skills: { type: "array", description: "技能列表" },
          },
        },
      },
      // ─── skill.status ─────────────────────────────────────────────
      {
        name: "skill.status",
        displayName: { "zh-CN": "查看技能状态", "en-US": "Get skill status" },
        description: { "zh-CN": "查看指定技能的详细状态", "en-US": "Get detailed status of a specific skill" },
        scope: "read",
        resourceType: "skill",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            skillName: { type: "string", required: true, description: "技能名称" },
          },
        },
        outputSchema: {
          fields: {
            skill: { type: "object", description: "技能详情" },
            enabled: { type: "boolean", description: "是否启用" },
            status: { type: "string", description: "当前状态" },
          },
        },
      },
      // ─── skill.enable ─────────────────────────────────────────────
      {
        name: "skill.enable",
        displayName: { "zh-CN": "启用技能", "en-US": "Enable skill" },
        description: { "zh-CN": "启用指定的技能", "en-US": "Enable a specific skill" },
        scope: "write",
        resourceType: "skill",
        action: "enable",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            skillName: { type: "string", required: true, description: "技能名称" },
            scopeType: { type: "string", description: "作用域: user/space/tenant" },
            reason: { type: "string", description: "启用原因" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            event: { type: "object", description: "生命周期事件" },
          },
        },
      },
      // ─── skill.disable ────────────────────────────────────────────
      {
        name: "skill.disable",
        displayName: { "zh-CN": "禁用技能", "en-US": "Disable skill" },
        description: { "zh-CN": "禁用指定的技能", "en-US": "Disable a specific skill" },
        scope: "write",
        resourceType: "skill",
        action: "disable",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            skillName: { type: "string", required: true, description: "技能名称" },
            reason: { type: "string", description: "禁用原因" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            event: { type: "object", description: "生命周期事件" },
          },
        },
      },
      // ─── skill.config.get ─────────────────────────────────────────
      {
        name: "skill.config.get",
        displayName: { "zh-CN": "获取技能配置", "en-US": "Get skill config" },
        description: { "zh-CN": "获取指定技能的配置参数", "en-US": "Get configuration of a specific skill" },
        scope: "read",
        resourceType: "skill",
        action: "config.read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            skillName: { type: "string", required: true, description: "技能名称" },
          },
        },
        outputSchema: {
          fields: {
            config: { type: "object", description: "配置参数" },
          },
        },
      },
      // ─── skill.config.set ─────────────────────────────────────────
      {
        name: "skill.config.set",
        displayName: { "zh-CN": "修改技能配置", "en-US": "Set skill config" },
        description: { "zh-CN": "修改指定技能的配置参数", "en-US": "Update configuration of a specific skill" },
        scope: "write",
        resourceType: "skill",
        action: "config.write",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            skillName: { type: "string", required: true, description: "技能名称" },
            configKey: { type: "string", required: true, description: "配置项名称" },
            configValue: { type: "any", required: true, description: "配置值" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            previousValue: { type: "any", description: "修改前的值" },
          },
        },
      },
      // ─── skill.generate ───────────────────────────────────────────
      {
        name: "skill.generate",
        displayName: { "zh-CN": "生成技能草稿", "en-US": "Generate skill draft" },
        description: { "zh-CN": "根据描述生成新技能的代码草稿", "en-US": "Generate a new skill code draft based on description" },
        scope: "write",
        resourceType: "skill",
        action: "generate",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            description: { type: "string", required: true, description: "技能功能描述" },
            skillName: { type: "string", description: "技能名称（可选，自动生成）" },
            inputFields: { type: "array", description: "输入参数定义" },
            outputFields: { type: "array", description: "输出参数定义" },
          },
        },
        outputSchema: {
          fields: {
            draft: { type: "object", description: "技能草稿" },
            code: { type: "object", description: "生成的代码（index和routes）" },
            manifest: { type: "object", description: "生成的manifest" },
          },
        },
      },
      // ─── skill.draft.list ─────────────────────────────────────────────
      {
        name: "skill.draft.list",
        displayName: { "zh-CN": "列出技能草稿", "en-US": "List skill drafts" },
        description: { "zh-CN": "列出我的技能草稿", "en-US": "List my skill drafts" },
        scope: "read",
        resourceType: "skill_draft",
        action: "list",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            status: { type: "string", description: "状态过滤：draft/reviewing/approved/rejected/published" },
          },
        },
        outputSchema: {
          fields: {
            drafts: { type: "array", description: "草稿列表" },
          },
        },
      },
      // ─── skill.draft.get ──────────────────────────────────────────────
      {
        name: "skill.draft.get",
        displayName: { "zh-CN": "查看技能草稿", "en-US": "Get skill draft" },
        description: { "zh-CN": "查看指定技能草稿的详情", "en-US": "Get details of a specific skill draft" },
        scope: "read",
        resourceType: "skill_draft",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            draftId: { type: "string", required: true, description: "草稿ID" },
          },
        },
        outputSchema: {
          fields: {
            draft: { type: "object", description: "草稿详情" },
          },
        },
      },
      // ─── skill.draft.update ───────────────────────────────────────────
      {
        name: "skill.draft.update",
        displayName: { "zh-CN": "更新技能草稿代码", "en-US": "Update skill draft code" },
        description: { "zh-CN": "修改技能草稿的代码", "en-US": "Update the code of a skill draft" },
        scope: "write",
        resourceType: "skill_draft",
        action: "update",
        idempotencyRequired: true,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            draftId: { type: "string", required: true, description: "草稿ID" },
            indexCode: { type: "string", description: "index.ts代码" },
            routesCode: { type: "string", description: "routes.ts代码" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            draft: { type: "object", description: "更新后的草稿" },
          },
        },
      },
      // ─── skill.draft.submit ───────────────────────────────────────────
      {
        name: "skill.draft.submit",
        displayName: { "zh-CN": "提交技能草稿审核", "en-US": "Submit skill draft for review" },
        description: { "zh-CN": "提交技能草稿进行审核", "en-US": "Submit a skill draft for review" },
        scope: "write",
        resourceType: "skill_draft",
        action: "submit",
        idempotencyRequired: true,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            draftId: { type: "string", required: true, description: "草稿ID" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            draft: { type: "object", description: "提交后的草稿" },
          },
        },
      },
      // ─── skill.draft.delete ───────────────────────────────────────────
      {
        name: "skill.draft.delete",
        displayName: { "zh-CN": "删除技能草稿", "en-US": "Delete skill draft" },
        description: { "zh-CN": "删除指定的技能草稿", "en-US": "Delete a specific skill draft" },
        scope: "write",
        resourceType: "skill_draft",
        action: "delete",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            draftId: { type: "string", required: true, description: "草稿ID" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
          },
        },
      },
      // ─── skill.draft.publish (确认即生效) ─────────────────────
      {
        name: "skill.draft.publish",
        displayName: { "zh-CN": "发布技能", "en-US": "Publish skill" },
        description: { "zh-CN": "发布技能草稿，确认后立即生效", "en-US": "Publish a skill draft, active immediately after confirmation" },
        scope: "write",
        resourceType: "skill_draft",
        action: "publish",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            draftId: { type: "string", required: true, description: "草稿ID" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean" },
            message: { type: "object", description: "发布结果消息" },
            artifactId: { type: "string", description: "工件ID" },
            toolName: { type: "string", description: "技能名称" },
            publishedAt: { type: "string", description: "发布时间" },
          },
        },
      },
      // ─── skill.custom.list (前端可见自定义技能) ───────────────
      {
        name: "skill.custom.list",
        displayName: { "zh-CN": "查看自定义技能", "en-US": "List custom skills" },
        description: { "zh-CN": "查看所有已发布的自定义技能", "en-US": "List all published custom skills" },
        scope: "read",
        resourceType: "skill",
        action: "list",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            limit: { type: "number", description: "返回数量限制" },
          },
        },
        outputSchema: {
          fields: {
            skills: { type: "array", description: "自定义技能列表" },
          },
        },
      },
    ],
  },
  routes: skillManagerRoutes,
};

export default plugin;
