import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { identityRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "identity.link", version: "1.0.0" },
    routes: ["/identity-links"],
    dependencies: ["audit", "rbac"],
  },
  routes: identityRoutes,
};

export default plugin;
