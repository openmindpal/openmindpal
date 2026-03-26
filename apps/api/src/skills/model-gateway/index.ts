/**
 * Built-in Skill: Model Gateway
 *
 * 提供模型接入的对话式管理能力：
 * - model.list: 列出已绑定的模型
 * - model.onboard: 一键接入新模型
 * - model.unbind: 解绑模型
 * - model.catalog: 查看支持的模型目录
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { modelRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "model.gateway", version: "1.0.0" },
    layer: "kernel", // 治理工具默认启用
    routes: ["/models"],
    frontend: ["/gov/models", "/gov/model-gateway", "/gov/routing"],
    dependencies: ["schemas", "entities", "audit", "rbac", "secrets"],
    tools: [
      // ─── model.list ───────────────────────────────────────────────
      {
        name: "model.list",
        displayName: { "zh-CN": "列出已绑定模型", "en-US": "List bound models" },
        description: { "zh-CN": "列出当前空间已绑定的所有模型及其状态", "en-US": "List all bound models and their status in current scope" },
        scope: "read",
        resourceType: "model",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {},
        },
        outputSchema: {
          fields: {
            bindings: { type: "array", description: "已绑定的模型列表" },
            scope: { type: "object", description: "当前作用域" },
          },
        },
      },
      // ─── model.onboard ───────────────────────────────────────────
      {
        name: "model.onboard",
        displayName: { "zh-CN": "一键接入模型", "en-US": "Onboard model" },
        description: {
          "zh-CN": "一键接入新模型，自动创建连接器、密钥并绑定（支持 DeepSeek、千问、豆包、智谱、Kimi 等）",
          "en-US": "Onboard a new model with one click - auto creates connector, secret and binding",
        },
        scope: "write",
        resourceType: "model",
        action: "onboard",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: {
              type: "string",
              required: true,
              description: "模型提供商: openai_compatible / deepseek / hunyuan / qianwen / doubao / zhipu / kimi / kimimax",
            },
            baseUrl: { type: "string", required: true, description: "API 基础地址，如 https://api.deepseek.com" },
            apiKey: { type: "string", required: true, description: "API 密钥" },
            modelName: { type: "string", required: true, description: "模型名称，如 deepseek-chat" },
            connectorInstanceName: { type: "string", description: "连接器实例名称（可选，自动生成）" },
          },
        },
        outputSchema: {
          fields: {
            binding: { type: "object", description: "创建的模型绑定" },
            connectionTestPassed: { type: "boolean", description: "连接测试是否通过" },
          },
        },
      },
      // ─── model.unbind ───────────────────────────────────────────
      {
        name: "model.unbind",
        displayName: { "zh-CN": "解绑模型", "en-US": "Unbind model" },
        description: { "zh-CN": "解绑已绑定的模型", "en-US": "Unbind a bound model" },
        scope: "write",
        resourceType: "model",
        action: "bind",
        idempotencyRequired: false,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            bindingId: { type: "string", required: true, description: "绑定 ID" },
          },
        },
        outputSchema: {
          fields: {
            deleted: { type: "boolean", description: "是否已删除" },
            binding: { type: "object", description: "被删除的绑定信息" },
          },
        },
      },
      // ─── model.catalog ───────────────────────────────────────────
      {
        name: "model.catalog",
        displayName: { "zh-CN": "查看模型目录", "en-US": "View model catalog" },
        description: { "zh-CN": "查看系统支持的模型提供商和模型列表", "en-US": "View supported model providers and models" },
        scope: "read",
        resourceType: "model",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: { type: "string", description: "按提供商过滤（可选）" },
          },
        },
        outputSchema: {
          fields: {
            catalog: { type: "array", description: "模型目录列表" },
          },
        },
      },
    ],
  },
  routes: modelRoutes,
};

export default plugin;
