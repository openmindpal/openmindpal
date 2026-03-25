import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { modelCatalog, openaiCompatibleProviders } from "./modules/catalog";

export const modelCatalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/models/catalog", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    const decision = await requirePermission({ req, resourceType: "model", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const openaiCompatibleProvidersOut = [...openaiCompatibleProviders];
    return {
      catalog: modelCatalog,
      templates: {
        openaiCompatible: {
          providers: openaiCompatibleProvidersOut,
          modelRefPattern: "{provider}:{modelName}",
          baseUrlRules: {
            normalize: "trim; ensure http/https; strip trailing /v1; strip query/hash; strip trailing slashes",
            endpointHost: "hostname(baseUrl) must be in allowedDomains",
          },
        },
      },
    };
  });
};
