import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { artifactRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "artifact.manager", version: "1.0.0" },
    routes: ["/artifacts"],
    frontend: ["/gov/artifact-policy"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: artifactRoutes,
};

export default plugin;
