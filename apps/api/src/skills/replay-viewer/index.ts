import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { replayRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "replay.viewer", version: "1.0.0" },
    routes: ["/replay"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: replayRoutes,
};

export default plugin;
