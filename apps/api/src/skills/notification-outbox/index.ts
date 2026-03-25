import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { notificationRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "notification.outbox", version: "1.0.0" },
    routes: ["/notifications"],
    frontend: ["/gov/notifications"],
    dependencies: ["audit", "rbac", "secrets"],
    skillDependencies: ["connector.manager"],
  },
  routes: notificationRoutes,
};
export default plugin;
