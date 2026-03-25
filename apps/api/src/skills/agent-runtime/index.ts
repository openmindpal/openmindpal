import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { agentRuntimeRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "agent.runtime", version: "1.0.0" },
    routes: ["/agent-runtime"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: agentRuntimeRoutes,
};

export default plugin;
