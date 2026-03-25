import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { aiEventReasoningRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "ai.event.reasoning", version: "1.0.0" },
    routes: ["/governance/event-reasoning"],
    frontend: ["/gov/event-reasoning"],
    dependencies: ["audit", "rbac"],
    skillDependencies: ["orchestrator.chat", "trigger.engine"],
  },
  routes: aiEventReasoningRoutes,
};

export default plugin;
