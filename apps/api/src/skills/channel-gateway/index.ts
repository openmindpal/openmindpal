/**
 * Built-in Skill: Channel Gateway
 *
 * 提供渠道接入的对话式管理能力：
 * - channel.config.list: 列出渠道配置
 * - channel.config.create: 创建渠道配置
 * - channel.test: 测试渠道连接
 * - channel.binding.initiate: 发起渠道绑定
 * - channel.binding.list: 列出绑定状态
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { channelRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "channel.gateway", version: "1.0.0" },
    layer: "kernel", // 治理工具默认启用
    routes: ["/channels", "/governance/channels", "/channels/binding"],
    frontend: ["/gov/channels"],
    dependencies: ["schemas", "entities", "audit", "rbac", "secrets"],
    skillDependencies: ["orchestrator.chat"],
    tools: [
      // ─── channel.config.list ─────────────────────────────────────
      {
        name: "channel.config.list",
        displayName: { "zh-CN": "列出渠道配置", "en-US": "List channel configs" },
        description: { "zh-CN": "列出当前租户的所有渠道配置（微信、钉钉、飞书、Slack 等）", "en-US": "List all channel configurations (WeChat, DingTalk, Feishu, Slack, etc.)" },
        scope: "read",
        resourceType: "channel",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: { type: "string", description: "按提供商过滤（可选）: feishu / dingtalk / wecom / slack / discord / qq.onebot" },
          },
        },
        outputSchema: {
          fields: {
            configs: { type: "array", description: "渠道配置列表" },
          },
        },
      },
      // ─── channel.config.create ───────────────────────────────────
      {
        name: "channel.config.create",
        displayName: { "zh-CN": "创建渠道配置", "en-US": "Create channel config" },
        description: {
          "zh-CN": "创建新的渠道配置（Webhook 模式）",
          "en-US": "Create a new channel configuration (Webhook mode)",
        },
        scope: "write",
        resourceType: "channel",
        action: "create",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: {
              type: "string",
              required: true,
              description: "渠道提供商: feishu / dingtalk / wecom / slack / discord / qq.onebot / imessage.bridge / custom",
            },
            workspaceId: { type: "string", required: true, description: "工作区 ID（用于区分同一提供商的不同配置）" },
            secretId: { type: "string", description: "密钥 ID（包含 webhookSecret / appId / appSecret 等）" },
            toleranceSec: { type: "number", description: "时间容差（秒），默认 300" },
          },
        },
        outputSchema: {
          fields: {
            config: { type: "object", description: "创建的渠道配置" },
          },
        },
      },
      // ─── channel.test ───────────────────────────────────────────
      {
        name: "channel.test",
        displayName: { "zh-CN": "测试渠道连接", "en-US": "Test channel connection" },
        description: { "zh-CN": "测试渠道配置是否正常工作", "en-US": "Test if the channel configuration is working" },
        scope: "read",
        resourceType: "channel",
        action: "test",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: { type: "string", required: true, description: "渠道提供商" },
            appId: { type: "string", description: "应用 ID（用于飞书等）" },
            appSecret: { type: "string", description: "应用密钥" },
          },
        },
        outputSchema: {
          fields: {
            success: { type: "boolean", description: "测试是否成功" },
            message: { type: "string", description: "测试结果消息" },
          },
        },
      },
      // ─── channel.binding.initiate ───────────────────────────────
      {
        name: "channel.binding.initiate",
        displayName: { "zh-CN": "发起渠道绑定", "en-US": "Initiate channel binding" },
        description: {
          "zh-CN": "发起渠道账号绑定流程（如绑定微信/钉钉等账号）",
          "en-US": "Initiate channel account binding flow (e.g., bind WeChat/DingTalk account)",
        },
        scope: "write",
        resourceType: "channel",
        action: "bind",
        idempotencyRequired: true,
        riskLevel: "medium",
        approvalRequired: false,
        inputSchema: {
          fields: {
            provider: {
              type: "string",
              required: true,
              description: "渠道提供商: feishu / dingtalk / wecom / slack",
            },
            workspaceId: { type: "string", required: true, description: "工作区 ID" },
          },
        },
        outputSchema: {
          fields: {
            authorizeUrl: { type: "string", description: "OAuth 授权链接（用户需访问此链接完成绑定）" },
            state: { type: "string", description: "绑定状态码" },
          },
        },
      },
      // ─── channel.binding.list ───────────────────────────────────
      {
        name: "channel.binding.list",
        displayName: { "zh-CN": "列出绑定状态", "en-US": "List binding states" },
        description: { "zh-CN": "列出当前用户的渠道绑定状态", "en-US": "List channel binding states for current user" },
        scope: "read",
        resourceType: "channel",
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
            bindings: { type: "array", description: "绑定状态列表" },
          },
        },
      },
      // ─── channel.providers ─────────────────────────────────────
      {
        name: "channel.providers",
        displayName: { "zh-CN": "查看支持的渠道", "en-US": "View supported channels" },
        description: { "zh-CN": "查看系统支持的渠道提供商列表", "en-US": "View list of supported channel providers" },
        scope: "read",
        resourceType: "channel",
        action: "read",
        idempotencyRequired: false,
        riskLevel: "low",
        approvalRequired: false,
        inputSchema: {
          fields: {},
        },
        outputSchema: {
          fields: {
            providers: {
              type: "array",
              description: "支持的渠道提供商: feishu(飞书), dingtalk(钉钉), wecom(企业微信), slack, discord, qq.onebot(QQ), imessage.bridge(iMessage)",
            },
          },
        },
      },
    ],
  },
  routes: channelRoutes,
};

export default plugin;
