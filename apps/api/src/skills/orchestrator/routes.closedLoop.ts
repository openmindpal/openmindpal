/**
 * Closed-loop execution runtime — facade.
 *
 * Delegates to:
 *   - closedLoopHandler.ts  — POST /orchestrator/closed-loop (initial)
 *   - closedLoopContinue.ts — POST /continue, /retry, /skip, /stop
 *
 * Shared types and utilities live in closedLoopUtils.ts.
 */
import type { FastifyPluginAsync } from "fastify";
import { closedLoopHandlerRoutes } from "./closedLoopHandler";
import { closedLoopContinueRoutes } from "./closedLoopContinue";

export const orchestratorClosedLoopRoutes: FastifyPluginAsync = async (app) => {
  await app.register(closedLoopHandlerRoutes);
  await app.register(closedLoopContinueRoutes);
};
