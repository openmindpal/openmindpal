import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { collabRuntimeRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "collab.runtime", version: "1.0.0" },
    routes: ["/collab-runtime"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: collabRuntimeRoutes,
};

export default plugin;
