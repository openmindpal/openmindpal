/**
 * Built-in Skill: Channel Gateway
 */
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { channelRoutes } from "./routes";

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "channel.gateway", version: "1.0.0" },
    routes: ["/channels", "/governance/channels", "/channels/binding"],
    frontend: ["/gov/channels"],
    dependencies: ["schemas", "entities", "audit", "rbac", "secrets"],
    skillDependencies: ["orchestrator.chat"],
  },
  routes: channelRoutes,
};

export default plugin;
