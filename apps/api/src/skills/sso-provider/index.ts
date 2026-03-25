import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { ssoRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: { identity: { name: "sso.provider", version: "1.0.0" }, routes: ["/sso"], dependencies: ["audit", "rbac"] },
  routes: ssoRoutes,
};
export default plugin;
