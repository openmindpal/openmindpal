import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { sha256Hex } from "../../lib/digest";
import { getToolNetworkPolicy, listToolNetworkPolicies, upsertToolNetworkPolicy } from "../../modules/governance/toolNetworkPolicyRepo";
import { getToolVersionByRef, listToolDefinitions, listToolVersions } from "../../modules/tools/toolRepo";
import { resolveSupplyChainPolicy, checkTrust, checkDependencyScan } from "@openslin/shared";
import { enableToolForScope, disableToolForScope, getActiveToolRef, listActiveToolRefs, listToolRollouts, setActiveToolRef } from "../../modules/governance/toolGovernanceRepo";
import { autoDiscoverAndRegisterTools } from "../../modules/tools/toolAutoDiscovery";

/* Throttle: run auto-discovery at most once per 30s per process */
let _lastDiscoveryAt = 0;
async function throttledAutoDiscovery(pool: any) {
  const now = Date.now();
  if (now - _lastDiscoveryAt < 30_000) return;
  _lastDiscoveryAt = now;
  try {
    await autoDiscoverAndRegisterTools(pool);
  } catch (err) {
    console.error("[tool-discovery] on-demand failed (non-fatal):", err);
  }
}

export const governanceToolsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/tools/network-policies", async (req) => {
    const q = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const list = await listToolNetworkPolicies({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { scopeType, count: list.length };
    return { items: list };
  });

  app.get("/governance/tools/:toolRef/network-policy", async (req, reply) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const q = z.object({ scopeType: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.read", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.read" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = q.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const pol = await getToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef });
    if (!pol) {
      req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, found: false };
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "策略不存在", "en-US": "Policy not found" }, traceId: req.ctx.traceId });
    }
    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, allowedDomainsCount: pol.allowedDomains.length };
    return pol;
  });

  app.put("/governance/tools/:toolRef/network-policy", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        allowedDomains: z.array(z.string().min(1)).max(500).optional(),
        rules: z
          .array(
            z.object({
              host: z.string().min(1).max(200),
              pathPrefix: z.string().min(1).max(500).optional(),
              methods: z.array(z.string().min(1).max(20)).max(20).optional(),
            }),
          )
          .max(500)
          .optional(),
      })
      .parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.network_policy.write", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.network_policy.write" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scopeType ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const canon = (body.allowedDomains ?? []).map((d) => d.trim()).filter(Boolean).sort();
    const digest = sha256Hex(canon.join("\n")).slice(0, 8);
    const rules = body.rules ?? [];
    const rulesDigest = sha256Hex(JSON.stringify(rules)).slice(0, 8);
    req.ctx.audit!.inputDigest = { scopeType, scopeId, toolRef: params.toolRef, allowedDomainsCount: canon.length, sha256_8: digest, rulesCount: rules.length, rulesSha256_8: rulesDigest };
    await upsertToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId, toolRef: params.toolRef, allowedDomains: canon, rules });
    req.ctx.audit!.outputDigest = { ok: true };
    return { ok: true };
  });

  app.post("/governance/tools/:toolRef/enable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.enable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.enable" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const { rollout, previousEnabled } = await enableToolForScope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      policyDecision: decision,
    });

    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, enabled: rollout.enabled, previousEnabled };
    return { rollout };
  });

  app.post("/governance/tools/:toolRef/disable", async (req) => {
    const params = z.object({ toolRef: z.string().min(3) }).parse(req.params);
    const body = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.disable", toolRef: params.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.disable" });
    req.ctx.audit!.policyDecision = decision;

    const scopeType = body.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const { rollout, previousEnabled } = await disableToolForScope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType,
      scopeId,
      toolRef: params.toolRef,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      policyDecision: decision,
    });

    req.ctx.audit!.outputDigest = { scopeType, scopeId, toolRef: params.toolRef, enabled: rollout.enabled, previousEnabled };
    return { rollout };
  });

  app.post("/governance/tools/:name/active", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const body = z.object({ toolRef: z.string().min(3) }).parse(req.body);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.set_active", toolRef: body.toolRef });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.set_active" });
    req.ctx.audit!.policyDecision = decision;

    if (!body.toolRef.startsWith(`${params.name}@`)) throw Errors.badRequest("toolRef 与 name 不匹配");
    const ver = await getToolVersionByRef(app.db, subject.tenantId, body.toolRef);
    if (!ver || ver.status !== "released") throw Errors.badRequest("工具版本不存在或未发布");
    if (ver.artifactRef) {
      const policy = resolveSupplyChainPolicy();
      const t = checkTrust(policy, ver.trustSummary);
      const s = checkDependencyScan(policy, ver.scanSummary);
      if (!t.ok) throw Errors.trustNotVerified();
      if (!s.ok) throw Errors.scanNotPassed();
    }

    const active = await setActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name, toolRef: body.toolRef });
    req.ctx.audit!.outputDigest = { name: params.name, activeToolRef: active.activeToolRef };
    return { active };
  });

  app.post("/governance/tools/:name/rollback", async (req) => {
    const params = z.object({ name: z.string().min(1) }).parse(req.params);
    const subject = req.ctx.subject!;

    setAuditContext(req, { resourceType: "governance", action: "tool.rollback" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.set_active" });
    req.ctx.audit!.policyDecision = decision;

    const active = await getActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name });
    if (!active) throw Errors.badRequest("当前未设置 activeToolRef");
    const idx = active.activeToolRef.lastIndexOf("@");
    const activeVersion = idx > 0 ? Number(active.activeToolRef.slice(idx + 1)) : NaN;
    if (!Number.isFinite(activeVersion) || activeVersion <= 0) throw Errors.badRequest("activeToolRef 格式错误");

    const versions = await listToolVersions(app.db, subject.tenantId, params.name);
    const prev = versions
      .filter((v) => v.status === "released" && v.version < activeVersion)
      .sort((a, b) => b.version - a.version)[0];
    if (!prev) throw Errors.badRequest("无可回滚的上一 released 版本");

    const next = await setActiveToolRef({ pool: app.db, tenantId: subject.tenantId, name: params.name, toolRef: prev.toolRef });
    req.ctx.audit!.outputDigest = { name: params.name, from: active.activeToolRef, to: next.activeToolRef };
    return { active: next };
  });

  app.get("/governance/tools", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "tool.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "tool.read" });
    req.ctx.audit!.policyDecision = decision;

    // Run auto-discovery (throttled) so page refresh picks up new tools
    await throttledAutoDiscovery(app.db);

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const scopeType = q.scope;
    const scopeId = scopeType === "space" ? subject.spaceId : scopeType === "tenant" ? subject.tenantId : undefined;

    const [tools, rollouts, actives] = await Promise.all([
      listToolDefinitions(app.db, subject.tenantId),
      listToolRollouts({ pool: app.db, tenantId: subject.tenantId, scopeType, scopeId }),
      listActiveToolRefs({ pool: app.db, tenantId: subject.tenantId }),
    ]);
    const activeMap = new Map(actives.map((a) => [a.name, a.activeToolRef]));
    const toolsWithActive = tools.map((t) => ({
      ...t,
      activeToolRef: activeMap.get(t.name) ?? null,
    }));
    req.ctx.audit!.outputDigest = { tools: tools.length, rollouts: rollouts.length, actives: actives.length };
    return { tools: toolsWithActive, rollouts, actives };
  });
};

