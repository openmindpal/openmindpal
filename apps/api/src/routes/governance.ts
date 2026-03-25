import type { FastifyPluginAsync } from "fastify";
import { governanceIndexRoutes } from "./governance/index";

export const governanceRoutes: FastifyPluginAsync = async (app) => {
  await app.register(governanceIndexRoutes);
};

