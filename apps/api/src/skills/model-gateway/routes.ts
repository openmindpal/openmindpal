import type { FastifyPluginAsync } from "fastify";
import { modelCatalogRoutes } from "./routes.catalog";
import { modelBindingRoutes } from "./routes.bindings";
import { modelOnboardRoutes } from "./routes.onboard";
import { modelChatRoutes } from "./routes.chat";

export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.register(modelCatalogRoutes);
  app.register(modelBindingRoutes);
  app.register(modelOnboardRoutes);
  app.register(modelChatRoutes);
};
