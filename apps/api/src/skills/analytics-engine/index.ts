import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { analyticsApiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "analytics.engine", version: "1.0.0" },
    routes: ["/analytics"],
    frontend: ["/gov/observability"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: analyticsApiRoutes,
};

export default plugin;
