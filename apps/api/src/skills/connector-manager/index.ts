import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { connectorRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "connector.manager", version: "1.0.0" },
    routes: ["/connectors"],
    frontend: ["/gov/integrations"],
    dependencies: ["audit", "rbac", "secrets"],
  },
  routes: connectorRoutes,
};
export default plugin;
