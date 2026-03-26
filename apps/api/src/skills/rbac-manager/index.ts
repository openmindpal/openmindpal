/**
 * Built-in Skill: RBAC Manager
 *
 * 提供权限管理的对话式管理能力：
 * - rbac.role.list: 列出角色
 * - rbac.role.create: 创建角色
 * - rbac.role.delete: 删除角色
 * - rbac.permission.list: 列出权限
 * - rbac.permission.grant: 授予权限
 * - rbac.permission.revoke: 撤销权限
 * - rbac.binding.list: 列出角色绑定
 * - rbac.binding.create: 创建角色绑定
 * - rbac.binding.delete: 删除角色绑定
 * - rbac.policy.list: 列出访问策略
 * - rbac.policy.create: 创建访问策略
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { rbacManagerRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "rbac.manager", version: "1.0.0" },
    layer: "builtin",
    routes: ["/rbac-manager"],
    dependencies: ["audit", "rbac"],
    tools: [
      // ─── rbac.role.list ─────────────────────────────────────────────
      {
        name: "rbac.role.list",
        displayName: { "zh-CN": "列出角色", "en-US": "List roles" },
        description: { "zh-CN": "列出当前租户的所有角色", "en-US": "List all roles in current tenant" },
        scope: "read",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {},
        },
        outputSchema: {
          fields: {
            roles: { type: "array", description: "角色列表" },
          },
        },
      },
      // ─── rbac.role.create ───────────────────────────────────────────
      {
        name: "rbac.role.create",
        displayName: { "zh-CN": "创建角色", "en-US": "Create role" },
        description: { "zh-CN": "创建新的角色", "en-US": "Create a new role" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            name: { type: "string", required: true, description: "角色名称" },
            id: { type: "string", description: "角色 ID（可选，自动生成）" },
          },
        },
        outputSchema: {
          fields: {
            role: { type: "object", description: "创建的角色" },
          },
        },
      },
      // ─── rbac.role.delete ───────────────────────────────────────────
      {
        name: "rbac.role.delete",
        displayName: { "zh-CN": "删除角色", "en-US": "Delete role" },
        description: { "zh-CN": "删除指定的角色", "en-US": "Delete a specific role" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: {
          fields: {
            roleId: { type: "string", required: true, description: "角色 ID" },
          },
        },
        outputSchema: {
          fields: {
            deleted: { type: "boolean", description: "是否已删除" },
          },
        },
      },
      // ─── rbac.permission.list ───────────────────────────────────────
      {
        name: "rbac.permission.list",
        displayName: { "zh-CN": "列出权限", "en-US": "List permissions" },
        description: { "zh-CN": "列出系统中所有已定义的权限", "en-US": "List all defined permissions in the system" },
        scope: "read",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {},
        },
        outputSchema: {
          fields: {
            permissions: { type: "array", description: "权限列表" },
          },
        },
      },
      // ─── rbac.permission.grant ──────────────────────────────────────
      {
        name: "rbac.permission.grant",
        displayName: { "zh-CN": "授予权限", "en-US": "Grant permission" },
        description: { "zh-CN": "为角色授予指定权限", "en-US": "Grant a specific permission to a role" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: false,
        inputSchema: {
          fields: {
            roleId: { type: "string", required: true, description: "角色 ID" },
            resourceType: { type: "string", required: true, description: "资源类型" },
            action: { type: "string", required: true, description: "操作动作" },
            fieldRulesRead: { type: "object", description: "读字段规则（可选）" },
            fieldRulesWrite: { type: "object", description: "写字段规则（可选）" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean", description: "是否成功" },
          },
        },
      },
      // ─── rbac.permission.revoke ─────────────────────────────────────
      {
        name: "rbac.permission.revoke",
        displayName: { "zh-CN": "撤销权限", "en-US": "Revoke permission" },
        description: { "zh-CN": "撤销角色的指定权限", "en-US": "Revoke a specific permission from a role" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "high",
        approvalRequired: false,
        inputSchema: {
          fields: {
            roleId: { type: "string", required: true, description: "角色 ID" },
            resourceType: { type: "string", required: true, description: "资源类型" },
            action: { type: "string", required: true, description: "操作动作" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean", description: "是否成功" },
          },
        },
      },
      // ─── rbac.binding.list ──────────────────────────────────────────
      {
        name: "rbac.binding.list",
        displayName: { "zh-CN": "列出角色绑定", "en-US": "List role bindings" },
        description: { "zh-CN": "列出当前租户的所有角色绑定", "en-US": "List all role bindings in current tenant" },
        scope: "read",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            subjectId: { type: "string", description: "按主体 ID 过滤（可选）" },
            roleId: { type: "string", description: "按角色 ID 过滤（可选）" },
          },
        },
        outputSchema: {
          fields: {
            bindings: { type: "array", description: "角色绑定列表" },
          },
        },
      },
      // ─── rbac.binding.create ────────────────────────────────────────
      {
        name: "rbac.binding.create",
        displayName: { "zh-CN": "创建角色绑定", "en-US": "Create role binding" },
        description: { "zh-CN": "将角色绑定给用户", "en-US": "Bind a role to a user" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: false,
        inputSchema: {
          fields: {
            subjectId: { type: "string", required: true, description: "主体（用户）ID" },
            roleId: { type: "string", required: true, description: "角色 ID" },
            scopeType: { type: "string", required: true, description: "作用域类型: tenant / space" },
            scopeId: { type: "string", required: true, description: "作用域 ID" },
          },
        },
        outputSchema: {
          fields: {
            binding: { type: "object", description: "创建的角色绑定" },
          },
        },
      },
      // ─── rbac.binding.delete ────────────────────────────────────────
      {
        name: "rbac.binding.delete",
        displayName: { "zh-CN": "删除角色绑定", "en-US": "Delete role binding" },
        description: { "zh-CN": "删除指定的角色绑定", "en-US": "Delete a specific role binding" },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "high",
        approvalRequired: false,
        inputSchema: {
          fields: {
            bindingId: { type: "string", required: true, description: "绑定 ID" },
          },
        },
        outputSchema: {
          fields: {
            deleted: { type: "boolean", description: "是否已删除" },
          },
        },
      },
      // ─── rbac.policy.list ───────────────────────────────────────────
      {
        name: "rbac.policy.list",
        displayName: { "zh-CN": "列出访问策略", "en-US": "List access policies" },
        description: { "zh-CN": "列出基于属性的访问控制策略（ABAC）", "en-US": "List attribute-based access control policies (ABAC)" },
        scope: "read",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {},
        },
        outputSchema: {
          fields: {
            policies: { type: "array", description: "策略列表" },
          },
        },
      },
      // ─── rbac.policy.create ─────────────────────────────────────────
      {
        name: "rbac.policy.create",
        displayName: { "zh-CN": "创建访问策略", "en-US": "Create access policy" },
        description: {
          "zh-CN": "创建基于属性的访问控制策略（如时间窗口、IP 限制等）",
          "en-US": "Create an attribute-based access control policy (e.g., time windows, IP restrictions)",
        },
        scope: "write",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: false,
        inputSchema: {
          fields: {
            policyName: { type: "string", required: true, description: "策略名称" },
            description: { type: "string", description: "策略描述" },
            resourceType: { type: "string", description: "适用的资源类型" },
            action: { type: "string", description: "适用的操作动作" },
            priority: { type: "number", description: "优先级（数值越小优先级越高）" },
            effect: { type: "string", required: true, description: "效果: allow / deny" },
            conditions: { type: "object", description: "条件表达式" },
          },
        },
        outputSchema: {
          fields: {
            policy: { type: "object", description: "创建的策略" },
          },
        },
      },
      // ─── rbac.summary ───────────────────────────────────────────────
      {
        name: "rbac.summary",
        displayName: { "zh-CN": "权限摘要", "en-US": "Permission summary" },
        description: { "zh-CN": "查看当前用户或指定用户的权限摘要", "en-US": "View permission summary for current or specified user" },
        scope: "read",
        resourceType: "rbac",
        action: "manage",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            subjectId: { type: "string", description: "主体 ID（可选，默认当前用户）" },
          },
        },
        outputSchema: {
          fields: {
            roles: { type: "array", description: "拥有的角色" },
            permissions: { type: "array", description: "有效权限列表" },
          },
        },
      },
    ],
  },
  routes: rbacManagerRoutes,
};

export default plugin;
