import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { safetyPolicyRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "safety.policy", version: "1.0.0" },
    routes: ["/safety-policies"],
    frontend: ["/gov/safety-policies"],
    dependencies: ["audit", "rbac"],
  },
  routes: safetyPolicyRoutes,
};
export default plugin;
