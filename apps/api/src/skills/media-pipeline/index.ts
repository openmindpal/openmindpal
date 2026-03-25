import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { mediaRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "media.pipeline", version: "1.0.0" },
    routes: ["/media"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: mediaRoutes,
};

export default plugin;
