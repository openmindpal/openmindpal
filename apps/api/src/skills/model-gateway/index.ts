/**
 * Built-in Skill: Model Gateway
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { modelRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "model.gateway", version: "1.0.0" },
    routes: ["/models"],
    frontend: ["/gov/models", "/gov/model-gateway", "/gov/routing"],
    dependencies: ["schemas", "entities", "audit", "rbac", "secrets"],
  },
  routes: modelRoutes,
};

export default plugin;
