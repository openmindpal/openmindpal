import type { FastifyPluginAsync } from "fastify";
import type { BuiltinSkillPlugin } from "../../lib/skillPlugin";
import { deviceRoutes } from "./routeDevices";
import { deviceAgentRoutes } from "./routeDeviceAgent";
import { deviceExecutionRoutes } from "./routeDeviceExecutions";

/** Composite route that registers all three device sub-routes. */
const compositeRoutes: FastifyPluginAsync = async (app) => {
  app.register(deviceRoutes);
  app.register(deviceAgentRoutes);
  app.register(deviceExecutionRoutes);
};

const plugin: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "device.runtime", version: "1.0.0" },
    routes: ["/devices", "/device-agent", "/device-executions"],
    frontend: ["/gov/devices"],
    dependencies: ["schemas", "entities", "audit", "rbac"],
  },
  routes: compositeRoutes,
};

export default plugin;
