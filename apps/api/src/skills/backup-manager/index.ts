import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { backupRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "backup.manager", version: "1.0.0" },
    routes: ["/backups"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: backupRoutes,
};

export default plugin;
