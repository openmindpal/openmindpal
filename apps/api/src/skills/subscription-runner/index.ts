import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { subscriptionRoutes } from "./routes";
const plugin: BuiltinSkillPlugin = {
  manifest: { identity: { name: "subscription.runner", version: "1.0.0" }, routes: ["/subscriptions"], dependencies: ["audit", "rbac"] },
  routes: subscriptionRoutes,
};
export default plugin;
