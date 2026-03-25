/**
 * Built-in Skill: UI Page Config
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { uiRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "ui.page-config", version: "1.0.0" },
    routes: ["/ui"],
    frontend: ["/gov/ui-pages"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: uiRoutes,
};

export default plugin;
