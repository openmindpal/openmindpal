/**
 * Built-in Skill: Orchestrator (Chat/AI)
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { orchestratorRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "orchestrator.chat", version: "1.0.0" },
    routes: ["/orchestrator"],
    frontend: ["/orchestrator"],
    dependencies: ["schemas", "entities", "tools", "audit", "rbac"],
    skillDependencies: ["nl2ui.generator", "model.gateway"],
  },
  routes: orchestratorRoutes,
};

export default plugin;
