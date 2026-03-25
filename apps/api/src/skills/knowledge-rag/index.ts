import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { knowledgeRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "knowledge.rag", version: "1.0.0" },
    routes: ["/knowledge"],
    frontend: ["/gov/knowledge"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
    tools: [
      {
        name: "knowledge.search",
        displayName: { "zh-CN": "知识检索", "en-US": "Knowledge search" },
        description: { "zh-CN": "检索知识库文档与证据", "en-US": "Search knowledge base for documents and evidence" },
        scope: "read",
        resourceType: "knowledge",
        action: "search",
        riskLevel: "low",
        inputSchema: { fields: { query: { type: "string", required: true }, limit: { type: "number" }, filters: { type: "json" } } },
        outputSchema: { fields: { retrievalLogId: { type: "string" }, evidence: { type: "json" }, candidateCount: { type: "number" } } },
      },
    ],
  },
  routes: knowledgeRoutes,
};
export default plugin;
