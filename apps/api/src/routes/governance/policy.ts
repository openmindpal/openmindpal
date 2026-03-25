import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { authorize } from "../../modules/auth/authz";
import { getPolicySnapshot, listPolicySnapshots } from "../../modules/auth/policySnapshotRepo";
import { bumpPolicyCacheEpoch, getPolicyCacheEpoch } from "../../modules/auth/policyCacheEpochRepo";
import { createDraftPolicyVersion, getPolicyVersion, listPolicyVersions, setPolicyVersionStatus } from "../../modules/auth/policyVersionRepo";
import { validatePolicyExpr } from "@openslin/shared";

export const governancePolicyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/policy/snapshots", async (req) => {
    const q = z
      .object({
        scope: z.enum(["tenant", "space"]).optional(),
        subjectId: z.string().min(1).optional(),
        resourceType: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        decision: z.enum(["allow", "deny"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
        cursorCreatedAt: z.string().min(10).optional(),
        cursorSnapshotId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "policy_snapshot", action: "list" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "policy_snapshot.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    req.ctx.audit!.inputDigest = {
      scopeType,
      subjectId: q.subjectId ?? null,
      resourceType: q.resourceType ?? null,
      action: q.action ?? null,
      decision: q.decision ?? null,
      limit: q.limit ?? 50,
    };

    const res = await listPolicySnapshots({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      subjectId: q.subjectId,
      resourceType: q.resourceType,
      action: q.action,
      decision: q.decision,
      limit: q.limit ?? 50,
      cursor: q.cursorCreatedAt && q.cursorSnapshotId ? { createdAt: q.cursorCreatedAt, snapshotId: q.cursorSnapshotId } : undefined,
    });

    req.ctx.audit!.outputDigest = { count: res.items.length, nextCursor: res.nextCursor ?? null };
    return {
      items: res.items.map((s) => ({
        snapshotId: s.snapshotId,
        tenantId: s.tenantId,
        spaceId: s.spaceId,
        subjectId: s.subjectId,
        resourceType: s.resourceType,
        action: s.action,
        decision: s.decision,
        reason: s.reason,
        rowFilters: s.rowFilters,
        fieldRules: s.fieldRules,
        policyRef: s.policyRef,
        policyCacheEpoch: s.policyCacheEpoch,
        createdAt: s.createdAt,
      })),
      nextCursor: res.nextCursor,
    };
  });

  app.get("/governance/policy/snapshots/:snapshotId/explain", async (req, reply) => {
    const params = z.object({ snapshotId: z.string().uuid() }).parse(req.params);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "policy_snapshot", action: "explain" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "policy_snapshot.explain" });
    req.ctx.audit!.policyDecision = decision;

    const snap = await getPolicySnapshot({ pool: app.db, tenantId: subject.tenantId, snapshotId: params.snapshotId });
    if (!snap) {
      req.ctx.audit!.outputDigest = { snapshotId: params.snapshotId, found: false };
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "Policy Snapshot 不存在", "en-US": "Policy snapshot not found" },
        traceId: req.ctx.traceId,
      });
    }
    if (snap.spaceId && subject.spaceId && snap.spaceId !== subject.spaceId) {
      req.ctx.audit!.outputDigest = { snapshotId: params.snapshotId, found: false };
      return reply.status(404).send({
        errorCode: "NOT_FOUND",
        message: { "zh-CN": "Policy Snapshot 不存在", "en-US": "Policy snapshot not found" },
        traceId: req.ctx.traceId,
      });
    }

    req.ctx.audit!.outputDigest = { snapshotId: snap.snapshotId, decision: snap.decision, resourceType: snap.resourceType, action: snap.action };
    return {
      snapshotId: snap.snapshotId,
      tenantId: snap.tenantId,
      spaceId: snap.spaceId,
      resourceType: snap.resourceType,
      action: snap.action,
      decision: snap.decision,
      reason: snap.reason,
      matchedRules: snap.matchedRules,
      rowFilters: snap.rowFilters,
      fieldRules: snap.fieldRules,
      policyRef: snap.policyRef,
      policyCacheEpoch: snap.policyCacheEpoch,
      explainV1: snap.explainV1,
      createdAt: snap.createdAt,
    };
  });

  app.post("/governance/policy/debug/evaluate", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
        subjectId: z.string().min(1),
        resourceType: z.string().min(1),
        action: z.string().min(1),
        context: z.unknown().optional(),
        mode: z.enum(["read", "write"]).optional(),
      })
      .parse(req.body);
    const actor = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_debug", action: "evaluate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_debug.evaluate" });

    if (body.scopeType === "tenant" && body.scopeId !== actor.tenantId) throw Errors.policyDebugInvalidInput("scopeId 必须等于 tenantId");
    if (body.scopeType === "space") {
      const r = await app.db.query("SELECT 1 FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [body.scopeId, actor.tenantId]);
      if (!r.rowCount) throw Errors.policyDebugInvalidInput("space 不存在或不属于当前 tenant");
    }
    const sub = await app.db.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [body.subjectId]);
    if (!sub.rowCount) throw Errors.policyDebugInvalidInput("subject 不存在");
    if (String(sub.rows[0].tenant_id) !== actor.tenantId) throw Errors.policyDebugInvalidInput("subject 不属于当前 tenant");

    req.ctx.audit!.inputDigest = {
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      action: body.action,
      hasContext: body.context !== undefined,
      mode: body.mode ?? null,
    };

    const decision = await authorize({
      pool: app.db,
      tenantId: actor.tenantId,
      spaceId: body.scopeType === "space" ? body.scopeId : undefined,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      action: body.action,
    });
    const snapRef = String((decision as any).snapshotRef ?? "");
    const snapshotId = snapRef.startsWith("policy_snapshot:") ? snapRef.slice("policy_snapshot:".length) : "";
    if (!snapshotId) throw Errors.internal();
    const matchedRules: any = (decision as any).matchedRules ?? null;
    const roleIds = Array.isArray(matchedRules?.roleIds) ? matchedRules.roleIds : [];
    const perms = Array.isArray(matchedRules?.permissions) ? matchedRules.permissions : [];
    const warnings: string[] = [];
    const reason = typeof decision.reason === "string" ? decision.reason : null;
    if (reason === "unsupported_policy_expr") warnings.push("unsupported_policy_expr");
    if (reason === "unsupported_row_filters") warnings.push("unsupported_row_filters");

    req.ctx.audit!.outputDigest = { decision: decision.decision, snapshotId, roleCount: roleIds.length, permissionCount: perms.length, warningsCount: warnings.length };
    return {
      decision: decision.decision,
      reason: reason,
      policyRef: (decision as any).policyRef ?? null,
      policyCacheEpoch: (decision as any).policyCacheEpoch ?? null,
      policySnapshotId: snapshotId,
      matchedRulesSummary: { roleCount: roleIds.length, permissionCount: perms.length },
      fieldRulesEffective: (decision as any).fieldRules ?? null,
      rowFiltersEffective: (decision as any).rowFilters ?? null,
      explainV1: (decision as any).explainV1 ?? null,
      warnings,
    };
  });

  app.get("/governance/policy/cache/epoch", async (req) => {
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional(), scopeId: z.string().min(1).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_cache", action: "epoch.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_cache.read" });
    const scopeType = q.scopeType ?? "space";
    const scopeId = q.scopeId ?? (scopeType === "tenant" ? subject.tenantId : subject.spaceId);
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");
    const epoch = await getPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType, scopeId });
    req.ctx.audit!.outputDigest = { scopeType, scopeId, epoch };
    return { scopeType, scopeId, epoch };
  });

  app.post("/governance/policy/cache/invalidate", async (req) => {
    const body = z.object({ scopeType: z.enum(["tenant", "space"]), scopeId: z.string().min(1), reason: z.string().min(1).max(500) }).parse(req.body);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_cache", action: "invalidate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy_cache.invalidate" });
    const out = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: body.scopeType, scopeId: body.scopeId });
    req.ctx.audit!.inputDigest = { scopeType: body.scopeType, scopeId: body.scopeId, reasonLen: body.reason.length };
    req.ctx.audit!.outputDigest = { ...out };
    return out;
  });

  app.get("/governance/policy/versions", async (req) => {
    const q = z
      .object({
        name: z.string().min(1).optional(),
        status: z.enum(["draft", "released", "deprecated"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.read" });
    const items = await listPolicyVersions({ pool: app.db as any, tenantId: subject.tenantId, name: q.name, status: q.status, limit: q.limit ?? 50 });
    req.ctx.audit!.inputDigest = { name: q.name ?? null, status: q.status ?? null, limit: q.limit ?? 50 };
    req.ctx.audit!.outputDigest = { count: items.length };
    return { items };
  });

  app.get("/governance/policy/versions/:name/:version", async (req, reply) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.read" });
    const ver = await getPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version });
    if (!ver) {
      req.ctx.audit!.outputDigest = { found: false, name: params.name, version: params.version };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "PolicyVersion 不存在", "en-US": "PolicyVersion not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = { found: true, name: ver.name, version: ver.version, status: ver.status };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions", async (req) => {
    const body = z.object({ name: z.string().min(1).max(200), policyJson: z.unknown() }).parse(req.body);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.write" });
    req.ctx.audit!.inputDigest = { name: body.name, hasPolicyJson: body.policyJson !== undefined };
    const ver = await createDraftPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: body.name, policyJson: body.policyJson });
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions/:name/:version/release", async (req) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "release" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.release" });
    const cur = await getPolicyVersion({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version });
    if (!cur) throw Errors.badRequest("PolicyVersion 不存在");
    if (cur.status !== "draft") throw Errors.badRequest("PolicyVersion 非 draft，无法发布");
    const policyJson = cur.policyJson;
    if (!policyJson || typeof policyJson !== "object") throw Errors.contractNotCompatible("policyJson 非对象");
    const expr = (policyJson as any).rowFiltersExpr ?? (policyJson as any).policyExpr ?? null;
    if (expr !== null && expr !== undefined) {
      const v = validatePolicyExpr(expr);
      if (!v.ok) throw Errors.contractNotCompatible(v.message);
    }
    const ver = await setPolicyVersionStatus({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version, status: "released" });
    if (!ver) throw Errors.badRequest("PolicyVersion 不存在");
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });

  app.post("/governance/policy/versions/:name/:version/deprecate", async (req) => {
    const params = z.object({ name: z.string().min(1), version: z.coerce.number().int().positive() }).parse(req.params);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "policy_version", action: "deprecate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "policy.write" });
    const ver = await setPolicyVersionStatus({ pool: app.db as any, tenantId: subject.tenantId, name: params.name, version: params.version, status: "deprecated" });
    if (!ver) throw Errors.badRequest("PolicyVersion 不存在");
    req.ctx.audit!.outputDigest = { name: ver.name, version: ver.version, status: ver.status, digest: ver.digest };
    return { item: ver, policyRef: { name: ver.name, version: ver.version } };
  });
};

