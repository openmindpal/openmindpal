import type { FastifyPluginAsync } from "fastify";
import { orchestratorTurnRoutes } from "./routes.turn";
import { orchestratorClosedLoopRoutes } from "./routes.closedLoop";
import { orchestratorExecuteRoutes } from "./routes.execute";
import { orchestratorTurnStreamRoutes } from "./routes.turnStream";

export const orchestratorRoutes: FastifyPluginAsync = async (app) => {
  app.register(orchestratorTurnRoutes);
  app.register(orchestratorClosedLoopRoutes);
  app.register(orchestratorExecuteRoutes);
  app.register(orchestratorTurnStreamRoutes);
};
