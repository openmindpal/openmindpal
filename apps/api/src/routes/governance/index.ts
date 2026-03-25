import type { FastifyPluginAsync } from "fastify";
import { governanceUiRoutes } from "./ui";
import { governanceSchemasRoutes } from "./schemas";
import { governanceArtifactPolicyRoutes } from "./artifactPolicy";
import { governanceToolsRoutes } from "./tools";
import { governancePolicyRoutes } from "./policy";
import { governanceObservabilityRoutes } from "./observability";
import { governanceSkillRuntimeRoutes } from "./skillRuntime";
import { governanceToolLimitsRoutes } from "./toolLimits";
import { governanceChangesetsAndEvalsRoutes } from "./changesetsAndEvals";
import { governanceKnowledgeRoutes } from "./knowledge";
import { governanceIntegrationsRoutes } from "./integrations";
import { governanceCollabRoutes } from "./collab";
import { governanceConfigRoutes } from "./config";

export const governanceIndexRoutes: FastifyPluginAsync = async (app) => {
  await app.register(governanceUiRoutes);
  await app.register(governanceSchemasRoutes);
  await app.register(governanceArtifactPolicyRoutes);
  await app.register(governanceToolsRoutes);
  await app.register(governancePolicyRoutes);
  await app.register(governanceObservabilityRoutes);
  await app.register(governanceSkillRuntimeRoutes);
  await app.register(governanceToolLimitsRoutes);
  await app.register(governanceChangesetsAndEvalsRoutes);
  await app.register(governanceKnowledgeRoutes);
  await app.register(governanceIntegrationsRoutes);
  await app.register(governanceCollabRoutes);
  await app.register(governanceConfigRoutes);
};

