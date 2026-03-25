import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { oauthRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: { identity: { name: "oauth.provider", version: "1.0.0" }, routes: ["/oauth"], dependencies: ["audit", "rbac", "secrets"] },
  routes: oauthRoutes,
};
export default plugin;
