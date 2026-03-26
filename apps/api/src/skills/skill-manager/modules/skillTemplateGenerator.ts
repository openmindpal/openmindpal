/**
 * Skill Template Generator
 *
 * 提供Skill代码模板生成能力，支持：
 * - 标准Skill脚手架生成
 * - AI辅助代码生成
 * - Manifest自动构建
 */

// ─── Template Types ─────────────────────────────────────────────────
export interface SkillTemplateField {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "any";
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
}

export interface SkillTemplateConfig {
  skillName: string;
  displayName?: { "zh-CN": string; "en-US": string };
  description: { "zh-CN": string; "en-US": string };
  inputFields: SkillTemplateField[];
  outputFields: SkillTemplateField[];
  riskLevel?: "low" | "medium" | "high";
  approvalRequired?: boolean;
  scope?: "read" | "write";
  resourceType?: string;
  action?: string;
  /** 是否需要外部API调用 */
  needsExternalApi?: boolean;
  /** 外部API的基础URL */
  externalApiBaseUrl?: string;
}

// ─── Code Generation ─────────────────────────────────────────────────

/**
 * 生成inputSchema/outputSchema JSON
 */
function generateSchemaJson(fields: SkillTemplateField[]): object {
  const schemaFields: Record<string, unknown> = {};
  for (const field of fields) {
    schemaFields[field.name] = {
      type: field.type,
      required: field.required ?? false,
      description: field.description ?? "",
    };
  }
  return { fields: schemaFields };
}

/**
 * 生成TypeScript类型定义
 */
function generateTypeDefinition(name: string, fields: SkillTemplateField[]): string {
  const lines: string[] = [`interface ${name} {`];
  for (const field of fields) {
    const optional = field.required ? "" : "?";
    let tsType = "unknown";
    switch (field.type) {
      case "string": tsType = "string"; break;
      case "number": tsType = "number"; break;
      case "boolean": tsType = "boolean"; break;
      case "object": tsType = "Record<string, unknown>"; break;
      case "array": tsType = "unknown[]"; break;
      case "any": tsType = "unknown"; break;
    }
    const comment = field.description ? `  /** ${field.description} */\n` : "";
    lines.push(`${comment}  ${field.name}${optional}: ${tsType};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * 生成Skill Manifest
 */
export function generateSkillManifest(config: SkillTemplateConfig): object {
  const toolName = `${config.skillName}.execute`;
  return {
    identity: { name: config.skillName, version: "1.0.0" },
    layer: "extension",
    routes: [`/${config.skillName.replace(/\./g, "-")}`],
    dependencies: ["audit", "rbac"],
    tools: [
      {
        name: toolName,
        displayName: config.displayName ?? {
          "zh-CN": config.description["zh-CN"].slice(0, 30),
          "en-US": config.description["en-US"].slice(0, 30),
        },
        description: config.description,
        scope: config.scope ?? "write",
        resourceType: config.resourceType ?? "custom",
        action: config.action ?? "execute",
        idempotencyRequired: false,
        riskLevel: config.riskLevel ?? "medium",
        approvalRequired: config.approvalRequired ?? false,
        inputSchema: generateSchemaJson(config.inputFields),
        outputSchema: generateSchemaJson(config.outputFields),
      },
    ],
  };
}

/**
 * 生成完整的Skill代码文件
 */
export function generateSkillCode(config: SkillTemplateConfig): {
  indexTs: string;
  routesTs: string;
  manifest: object;
} {
  const manifest = generateSkillManifest(config);
  const routePath = `/${config.skillName.replace(/\./g, "-")}`;
  const inputTypeName = `${pascalCase(config.skillName)}Input`;
  const outputTypeName = `${pascalCase(config.skillName)}Output`;

  // Generate index.ts
  const indexTs = `/**
 * ${config.skillName} — 自动生成的技能
 *
 * 描述: ${config.description["zh-CN"]}
 * 生成时间: ${new Date().toISOString()}
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { ${camelCase(config.skillName)}Routes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: ${JSON.stringify(manifest, null, 2).replace(/\n/g, "\n  ")},
  routes: ${camelCase(config.skillName)}Routes,
};

export default plugin;
`;

  // Generate routes.ts
  const inputTypedef = generateTypeDefinition(inputTypeName, config.inputFields);
  const outputTypedef = generateTypeDefinition(outputTypeName, config.outputFields);

  const externalApiCode = config.needsExternalApi
    ? `
// ─── External API Client ─────────────────────────────────────────────
const API_BASE_URL = process.env.${config.skillName.toUpperCase().replace(/\./g, "_")}_API_URL ?? "${config.externalApiBaseUrl ?? "https://api.example.com"}";

async function callExternalApi(endpoint: string, data: unknown): Promise<unknown> {
  const response = await fetch(\`\${API_BASE_URL}\${endpoint}\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(\`External API error: \${response.status}\`);
  }
  return response.json();
}
`
    : "";

  const routesTs = `/**
 * ${config.skillName} Routes
 *
 * HTTP API 实现
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";

// ─── Type Definitions ─────────────────────────────────────────────────
${inputTypedef}

${outputTypedef}
${externalApiCode}
// ─── Input Validation Schema ─────────────────────────────────────────
const inputSchema = z.object({
${config.inputFields.map((f) => {
    let zodType = "z.unknown()";
    switch (f.type) {
      case "string": zodType = "z.string()"; break;
      case "number": zodType = "z.number()"; break;
      case "boolean": zodType = "z.boolean()"; break;
      case "object": zodType = "z.record(z.unknown())"; break;
      case "array": zodType = "z.array(z.unknown())"; break;
    }
    if (!f.required) zodType += ".optional()";
    return `  ${f.name}: ${zodType},`;
  }).join("\n")}
});

// ─── Routes ──────────────────────────────────────────────────────────
export const ${camelCase(config.skillName)}Routes: FastifyPluginAsync = async (app) => {
  app.post("${routePath}/execute", async (req) => {
    setAuditContext(req, { resourceType: "${config.resourceType ?? "custom"}", action: "${config.action ?? "execute"}" });
    const decision = await requirePermission({ req, resourceType: "${config.resourceType ?? "custom"}", action: "${config.action ?? "execute"}" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const input = inputSchema.parse(req.body) as ${inputTypeName};

    // ─── TODO: 实现业务逻辑 ─────────────────────────────────────────
    console.log("[${config.skillName}] Execute called with input:", input);
${config.needsExternalApi ? `
    // 调用外部API示例
    // const apiResult = await callExternalApi("/your-endpoint", input);
` : ""}
    const output: ${outputTypeName} = {
${config.outputFields.map((f) => {
    let defaultVal = "null";
    switch (f.type) {
      case "string": defaultVal = '""'; break;
      case "number": defaultVal = "0"; break;
      case "boolean": defaultVal = "true"; break;
      case "object": defaultVal = "{}"; break;
      case "array": defaultVal = "[]"; break;
    }
    return `      ${f.name}: ${defaultVal}, // TODO: 填充实际值`;
  }).join("\n")}
    };

    req.ctx.audit!.outputDigest = { success: true };
    return { success: true, data: output };
  });
};
`;

  return { indexTs, routesTs, manifest };
}

// ─── Utility Functions ───────────────────────────────────────────────

function pascalCase(str: string): string {
  return str
    .split(/[.\-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function camelCase(str: string): string {
  const pascal = pascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ─── AI Prompt for Code Generation ───────────────────────────────────

/**
 * 生成AI代码生成的Prompt
 */
export function buildSkillGenerationPrompt(description: string, config?: Partial<SkillTemplateConfig>): string {
  return `你是一个专业的TypeScript开发者，需要根据以下需求生成一个灵智智能体系统的Skill技能代码。

## 需求描述
${description}

## 技能配置
${config ? JSON.stringify(config, null, 2) : "根据需求自动推断"}

## 输出要求
请生成以下内容：
1. skillName: 技能名称（小写，点分隔，如 "weather.query"）
2. displayName: 显示名称（中英文）
3. description: 功能描述（中英文）
4. inputFields: 输入参数列表
5. outputFields: 输出参数列表
6. businessLogic: 核心业务逻辑代码片段

## 输出格式
\`\`\`json
{
  "skillName": "xxx.xxx",
  "displayName": { "zh-CN": "xxx", "en-US": "xxx" },
  "description": { "zh-CN": "xxx", "en-US": "xxx" },
  "inputFields": [{ "name": "xxx", "type": "string", "required": true, "description": "xxx" }],
  "outputFields": [{ "name": "xxx", "type": "string", "description": "xxx" }],
  "businessLogic": "// 业务逻辑代码"
}
\`\`\`
`;
}

/**
 * 解析AI生成的Skill配置
 */
export function parseAiGeneratedConfig(aiOutput: string): SkillTemplateConfig | null {
  try {
    // 提取JSON块
    const jsonMatch = aiOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[1]);
    return {
      skillName: parsed.skillName ?? "custom.skill",
      displayName: parsed.displayName,
      description: parsed.description ?? { "zh-CN": "自定义技能", "en-US": "Custom skill" },
      inputFields: parsed.inputFields ?? [],
      outputFields: parsed.outputFields ?? [],
      riskLevel: parsed.riskLevel ?? "medium",
      scope: parsed.scope ?? "write",
    };
  } catch {
    return null;
  }
}
