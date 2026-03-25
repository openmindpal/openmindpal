import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { syncRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "sync.engine", version: "1.0.0" },
    routes: ["/sync"],
    frontend: ["/gov/sync", "/gov/sync-conflicts"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: syncRoutes,
};

export default plugin;
