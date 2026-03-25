import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { triggerRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "trigger.engine", version: "1.0.0" },
    routes: ["/triggers"],
    frontend: ["/gov/triggers"],
    dependencies: ["audit", "rbac"],
  },
  routes: triggerRoutes,
};
export default plugin;
