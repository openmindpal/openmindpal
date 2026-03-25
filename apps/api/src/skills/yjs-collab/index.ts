import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { yjsRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "yjs.collab", version: "1.0.0" },
    routes: ["/yjs"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: yjsRoutes,
};

export default plugin;
