import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { memoryRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "memory.manager", version: "1.0.0" },
    routes: ["/memory"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
    tools: [
      {
        name: "memory.read",
        displayName: { "zh-CN": "读取记忆", "en-US": "Read memory" },
        description: { "zh-CN": "检索长期记忆条目", "en-US": "Search long-term memory entries" },
        scope: "read",
        resourceType: "memory",
        action: "read",
        riskLevel: "low",
        inputSchema: { fields: { query: { type: "string", required: true }, scope: { type: "string" }, type: { type: "string" }, limit: { type: "number" } } },
        outputSchema: { fields: { entries: { type: "json" } } },
      },
      {
        name: "memory.write",
        displayName: { "zh-CN": "写入记忆", "en-US": "Write memory" },
        description: { "zh-CN": "写入长期记忆条目", "en-US": "Write a long-term memory entry" },
        scope: "write",
        resourceType: "memory",
        action: "write",
        riskLevel: "low",
        inputSchema: { fields: { scope: { type: "string" }, type: { type: "string", required: true }, title: { type: "string" }, contentText: { type: "string", required: true }, writePolicy: { type: "string" }, retentionDays: { type: "number" } } },
        outputSchema: { fields: { entry: { type: "json" }, dlpSummary: { type: "json" } } },
      },
    ],
  },
  routes: memoryRoutes,
};
export default plugin;
