import { z } from "zod";

/**
 * NL2UI - Natural Language to UI Generation
 * 将自然语言指令转换为动态 UI 配置
 */

// ─── Request Schema ──────────────────────────────────────────────────────

export const nl2uiRequestSchema = z.object({
  userInput: z.string().min(1).describe("用户自然语言输入，例如'显示我的旅行笔记'"),
  context: z.object({
    userId: z.string(),
    tenantId: z.string(),
    spaceId: z.string().optional(),
    conversationId: z.string().optional(),
  }).optional(),
  previousConfig: z.any().optional().describe("上一次生成的 UI 配置，用于迭代修改"),
  stylePrefs: z.object({
    fontSize: z.enum(["small", "medium", "large"]).optional(),
    cardStyle: z.enum(["minimal", "modern", "classic"]).optional(),
    colorTheme: z.enum(["blue", "green", "warm", "dark"]).optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
    defaultLayout: z.enum(["list", "cards", "kanban", "table"]).optional(),
  }).optional(),
});

export type Nl2UiRequest = z.infer<typeof nl2uiRequestSchema>;

// ─── Generated UI Config Schema ──────────────────────────────────────────

export const nl2uiGeneratedBlockSchema = z.object({
  id: z.string(),
  type: z.enum(["text", "heading", "heading2", "heading3", "code", "image", "divider", "list", "todo", "quote", "callout", "table", "embed", "toggle"]),
  content: z.string(),
  meta: z.record(z.string(), z.any()).optional(),
  children: z.array(z.any()).optional(),
});

export const nl2uiDataBindingSchema = z.object({
  id: z.string(),
  target: z.enum(["entities.list", "entities.query", "entities.get", "schema.effective"]),
  params: z.record(z.string(), z.any()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  sort: z.object({
    field: z.string(),
    direction: z.enum(["asc", "desc"]),
  }).optional(),
});

export const nl2uiLayoutSchema = z.object({
  variant: z.enum(["single-column", "split-horizontal", "split-vertical", "grid"]).describe("布局类型"),
  areas: z.array(z.object({
    name: z.string(),
    componentId: z.string(),
    props: z.record(z.string(), z.any()).optional(),
    dataBindingIds: z.array(z.string()).optional(),
  })).describe("布局区域定义"),
});

export const nl2uiGeneratedConfigSchema = z.object({
  // 生成的 UI 配置
  ui: z.object({
    layout: nl2uiLayoutSchema,
    blocks: z.array(nl2uiGeneratedBlockSchema),
  }),
  
  // 数据绑定配置
  dataBindings: z.array(nl2uiDataBindingSchema),
  
  // 动作绑定配置 (可选)
  actionBindings: z.array(z.object({
    action: z.enum(["create", "update", "delete"]),
    entityName: z.string(),
    toolRef: z.string().optional(),
    riskLevel: z.string().optional(),
  })).optional(),
  
  // 样式偏好应用
  appliedStylePrefs: z.record(z.string(), z.any()).optional(),
  
  // 大模型生成的自然语言回复（直接面向用户）
  replyText: z.string().optional().describe("大模型生成的自然语言回复文本"),

  // 大模型生成的后续建议（供前端展示）
  suggestions: z.array(z.string()).optional().describe("大模型生成的后续操作建议"),

  // 生成元数据
  metadata: z.object({
    generatedAt: z.string().datetime(),
    modelUsed: z.string(),
    confidence: z.number().min(0).max(1).describe("AI 生成置信度"),
  }),
});

export type Nl2UiGeneratedConfig = z.infer<typeof nl2uiGeneratedConfigSchema>;

// ─── Response Schema ─────────────────────────────────────────────────────

export const nl2uiResponseSchema = z.object({
  success: z.boolean(),
  config: nl2uiGeneratedConfigSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
  suggestions: z.array(z.string()).describe("建议的自然语言指令").optional(),
});

export type Nl2UiResponse = z.infer<typeof nl2uiResponseSchema>;
