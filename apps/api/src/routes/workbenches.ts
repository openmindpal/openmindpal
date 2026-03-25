import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { getDraftVersion, getLatestReleasedVersion, getWorkbenchPlugin, listWorkbenchPlugins, resolveEffectiveVersion, upsertDraftVersion } from "../modules/workbenches/workbenchRepo";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  app.post("/workbenches", async (req) => {
    setAuditContext(req, { resourceType: "workbench", action: "plugin.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workbench", action: "manage" });

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z.object({ workbenchKey: z.string().min(1), displayName: z.any().optional(), description: z.any().optional() }).parse(req.body);

    await app.db.query(
      `
        INSERT INTO workbench_plugins (tenant_id, scope_type, scope_id, workbench_key, display_name, description, created_by_subject_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id, scope_type, scope_id, workbench_key) DO UPDATE
        SET display_name = COALESCE(EXCLUDED.display_name, workbench_plugins.display_name),
            description = COALESCE(EXCLUDED.description, workbench_plugins.description),
            updated_at = now()
      `,
      [
        subject.tenantId,
        scope.scopeType,
        scope.scopeId,
        body.workbenchKey,
        body.displayName ? JSON.stringify(body.displayName) : null,
        body.description ? JSON.stringify(body.description) : null,
        subject.subjectId ?? null,
      ],
    );

    req.ctx.audit!.outputDigest = { workbenchKey: body.workbenchKey };
    return { ok: true };
  });

  app.get("/workbenches", async (req) => {
    setAuditContext(req, { resourceType: "workbench", action: "plugin.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workbench", action: "manage" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const items = await listWorkbenchPlugins({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId });
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/workbenches/:workbenchKey", async (req) => {
    const params = z.object({ workbenchKey: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "workbench", action: "plugin.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workbench", action: "manage" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);

    const plugin = await getWorkbenchPlugin({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, workbenchKey: params.workbenchKey });
    if (!plugin) throw Errors.notFound("workbench");
    const latestReleased = await getLatestReleasedVersion({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, workbenchKey: params.workbenchKey });
    const draft = await getDraftVersion({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId, workbenchKey: params.workbenchKey });
    req.ctx.audit!.outputDigest = { workbenchKey: params.workbenchKey, hasDraft: Boolean(draft), hasReleased: Boolean(latestReleased) };
    return { plugin, latestReleased, draft };
  });

  app.post("/workbenches/:workbenchKey/draft", async (req) => {
    const params = z.object({ workbenchKey: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "workbench", action: "version.draft.upsert" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workbench", action: "manage" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);

    const body = z.object({ artifactRef: z.string().min(1), manifest: z.any() }).parse(req.body);
    const draft = await upsertDraftVersion({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      workbenchKey: params.workbenchKey,
      artifactRef: body.artifactRef,
      manifestJson: body.manifest,
      createdBySubjectId: subject.subjectId ?? null,
    });

    req.ctx.audit!.outputDigest = { workbenchKey: params.workbenchKey, artifactRef: body.artifactRef, manifestDigest: draft.manifestDigest.slice(0, 8) };
    return { draft };
  });

  app.get("/workbenches/:workbenchKey/effective", async (req) => {
    const params = z.object({ workbenchKey: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "workbench", action: "effective.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workbench", action: "view" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);

    const v = await resolveEffectiveVersion({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      workbenchKey: params.workbenchKey,
      subjectId: subject.subjectId,
    });
    if (!v) throw Errors.notFound("workbench_version");

    const ver = await app.db.query(
      `
        SELECT *
        FROM workbench_plugin_versions
        WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND workbench_key = $4 AND status = 'released' AND version = $5
        LIMIT 1
      `,
      [subject.tenantId, scope.scopeType, scope.scopeId, params.workbenchKey, v],
    );
    if (!ver.rowCount) throw Errors.notFound("workbench_version");

    req.ctx.audit!.outputDigest = { workbenchKey: params.workbenchKey, effectiveVersion: v };
    return {
      workbenchKey: params.workbenchKey,
      version: v,
      artifactRef: ver.rows[0].artifact_ref,
      manifest: ver.rows[0].manifest_json,
      manifestDigest: ver.rows[0].manifest_digest,
    };
  });
};

