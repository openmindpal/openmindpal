import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { taskRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "task.manager", version: "1.0.0" },
    routes: ["/tasks"],
    frontend: ["/tasks"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: taskRoutes,
};

export default plugin;
