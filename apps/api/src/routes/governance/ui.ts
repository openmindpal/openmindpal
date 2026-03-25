import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getLatestReleasedUiComponentRegistry, getUiComponentRegistryDraft, publishUiComponentRegistryFromDraft, rollbackUiComponentRegistryToPreviousReleased, upsertUiComponentRegistryDraft } from "../../modules/governance/uiComponentRegistryRepo";
import { resolveScope, validateUiComponentRegistryComponentIds } from "./_shared";

export const governanceUiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/ui/component-registry", async (req) => {
    const subject = req.ctx.subject!;
    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query ?? {});
    const scope = resolveScope(subject, q.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.read" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const [latestReleased, draft] = await Promise.all([getLatestReleasedUiComponentRegistry(app.db, key), getUiComponentRegistryDraft(app.db, key)]);

    req.ctx.audit!.inputDigest = { scopeType: scope.scopeType, scopeId: scope.scopeId };
    req.ctx.audit!.outputDigest = { hasReleased: Boolean(latestReleased), hasDraft: Boolean(draft) };
    return { scope, latestReleased, draft };
  });

  app.put("/governance/ui/component-registry/draft", async (req) => {
    const subject = req.ctx.subject!;
    const body = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        componentIds: z.array(z.string().min(1).max(200)).max(2000),
      })
      .parse(req.body);
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.write" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.write" });

    validateUiComponentRegistryComponentIds(body.componentIds);

    const draft = await upsertUiComponentRegistryDraft({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      componentIds: body.componentIds,
      createdBySubjectId: subject.subjectId,
    });
    req.ctx.audit!.inputDigest = { scopeType: scope.scopeType, scopeId: scope.scopeId, componentIdsCount: body.componentIds.length };
    req.ctx.audit!.outputDigest = { version: draft.version, status: draft.status, componentIdsCount: draft.componentIds.length };
    return { scope, draft };
  });

  app.post("/governance/ui/component-registry/publish", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body ?? {});
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.publish" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.publish" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const draft = await getUiComponentRegistryDraft(app.db, key);
    if (!draft) throw Errors.uiComponentRegistryDraftMissing();
    validateUiComponentRegistryComponentIds(draft.componentIds);
    const released = await publishUiComponentRegistryFromDraft({ pool: app.db, key, createdBySubjectId: subject.subjectId, draft });
    if (!released) throw Errors.uiComponentRegistryDraftMissing();
    req.ctx.audit!.outputDigest = { version: released.version, status: released.status, componentIdsCount: released.componentIds.length };
    return { scope, released };
  });

  app.post("/governance/ui/component-registry/rollback", async (req) => {
    const subject = req.ctx.subject!;
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body ?? {});
    const scope = resolveScope(subject, body.scope ?? "space");

    setAuditContext(req, { resourceType: "governance", action: "ui.component_registry.rollback" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "ui.component_registry.rollback" });

    const key = { tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId } as const;
    const released = await rollbackUiComponentRegistryToPreviousReleased({ pool: app.db, key, createdBySubjectId: subject.subjectId });
    if (!released) throw Errors.uiComponentRegistryNoPreviousVersion();
    req.ctx.audit!.outputDigest = { version: released.version, status: released.status, componentIdsCount: released.componentIds.length };
    return { scope, released };
  });
};

