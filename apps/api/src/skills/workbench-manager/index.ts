/**
 * Built-in Skill: Workbench Manager
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { workbenchRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "workbench.manager", version: "1.0.0" },
    routes: ["/workbenches"],
    frontend: ["/gov/workbenches"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: workbenchRoutes,
};

export default plugin;
