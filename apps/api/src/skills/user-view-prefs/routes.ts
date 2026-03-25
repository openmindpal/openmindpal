import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import {
  upsertUserViewConfig,
  getUserViewConfig,
  listUserViewConfigs,
  deleteUserViewConfig,
  addDashboardShortcut,
  listDashboardShortcuts,
  updateDashboardShortcutOrder,
  deleteDashboardShortcut,
  reorderDashboardShortcuts,
} from "../ui-page-config/modules/userViewConfigRepo";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

export const userViewConfigRoutes: FastifyPluginAsync = async (app) => {
  // ─── User View Config ───────────────────────────────────────────────
  app.get("/user-view-configs", async (req) => {
    setAuditContext(req, { resourceType: "user_view_config", action: "list" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const query = z.object({ targetType: z.string().optional() }).parse(req.query);
    const configs = await listUserViewConfigs({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, ...scope, targetType: query.targetType });
    return { configs };
  });

  app.put("/user-view-configs", async (req) => {
    setAuditContext(req, { resourceType: "user_view_config", action: "upsert" });
    const decision = await requirePermission({ req, resourceType: "ui_config", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z.object({
      targetType: z.string().min(1),
      targetId: z.string().min(1),
      variant: z.enum(["desktop", "mobile"]).optional(),
      layout: z.any().optional(),
      visibleFields: z.any().optional(),
      sortConfig: z.any().optional(),
      filterConfig: z.any().optional(),
      shortcuts: z.any().optional(),
    }).parse(req.body);
    const config = await upsertUserViewConfig({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      ...scope,
      targetType: body.targetType,
      targetId: body.targetId,
      variant: body.variant ?? "desktop",
      layout: body.layout,
      visibleFields: body.visibleFields,
      sortConfig: body.sortConfig,
      filterConfig: body.filterConfig,
      shortcuts: body.shortcuts,
    });
    return { config };
  });

  app.delete("/user-view-configs/:configId", async (req) => {
    const params = z.object({ configId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "user_view_config", action: "delete" });
    await requirePermission({ req, resourceType: "ui_config", action: "read" });
    const subject = req.ctx.subject!;
    const ok = await deleteUserViewConfig({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, configId: params.configId });
    return { ok };
  });

  // ─── Dashboard Shortcuts ────────────────────────────────────────────
  app.get("/dashboard/shortcuts", async (req) => {
    setAuditContext(req, { resourceType: "dashboard_shortcut", action: "list" });
    await requirePermission({ req, resourceType: "ui_config", action: "read" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const shortcuts = await listDashboardShortcuts({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, ...scope });
    return { shortcuts };
  });

  app.post("/dashboard/shortcuts", async (req) => {
    setAuditContext(req, { resourceType: "dashboard_shortcut", action: "create" });
    await requirePermission({ req, resourceType: "ui_config", action: "read" });
    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z.object({
      targetType: z.string().min(1),
      targetId: z.string().min(1),
      displayName: z.any().optional(),
      icon: z.string().optional(),
      sortOrder: z.number().optional(),
    }).parse(req.body);
    const shortcut = await addDashboardShortcut({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, ...scope, ...body });
    return { shortcut };
  });

  app.put("/dashboard/shortcuts/reorder", async (req) => {
    setAuditContext(req, { resourceType: "dashboard_shortcut", action: "reorder" });
    await requirePermission({ req, resourceType: "ui_config", action: "read" });
    const subject = req.ctx.subject!;
    const body = z.object({ orderedIds: z.array(z.string()) }).parse(req.body);
    await reorderDashboardShortcuts({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, orderedIds: body.orderedIds });
    return { ok: true };
  });

  app.delete("/dashboard/shortcuts/:shortcutId", async (req) => {
    const params = z.object({ shortcutId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "dashboard_shortcut", action: "delete" });
    await requirePermission({ req, resourceType: "ui_config", action: "read" });
    const subject = req.ctx.subject!;
    const ok = await deleteDashboardShortcut({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, shortcutId: params.shortcutId });
    return { ok };
  });
};
