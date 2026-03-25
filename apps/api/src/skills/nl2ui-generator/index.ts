/**
 * Built-in Skill: NL2UI Generator
 *
 * Wraps the existing nl2ui routes and modules as a BuiltinSkillPlugin.
 * No code is moved — only the registration mechanism changes.
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { nl2uiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "nl2ui.generator", version: "1.0.0" },
    routes: ["/nl2ui"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
    tools: [
      {
        name: "nl2ui.generate",
        displayName: { "zh-CN": "NL2UI 页面生成", "en-US": "NL2UI Page Generation" },
        description: { "zh-CN": "根据自然语言描述自动生成前端界面页面", "en-US": "Generate frontend UI pages from natural language" },
        scope: "write",
        resourceType: "nl2ui",
        action: "generate",
        riskLevel: "low",
        inputSchema: { fields: { userInput: { type: "string", required: true }, stylePrefs: { type: "json" } } },
        outputSchema: { fields: { success: { type: "boolean" }, config: { type: "json" } } },
      },
    ],
  },
  routes: nl2uiRoutes,
};

export default plugin;
