import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { userViewConfigRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "user.view-prefs", version: "1.0.0" },
    routes: ["/user-view-configs"],
    dependencies: ["audit", "rbac"],
  },
  routes: userViewConfigRoutes,
};

export default plugin;
