import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { POLICY_EXPR_JSON_SCHEMA_V1, validatePolicyExpr } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { bumpPolicyCacheEpoch } from "../modules/auth/policyCacheEpochRepo";
import { evaluateAbacPolicy, parseAbacConditions, type AbacContext } from "../modules/auth/abacEngine";

function isSafeFieldName(name: string) {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function normalizeRowFilters(input: any): { normalized: any | null; usedPayloadPaths: string[] } {
  if (input === null || input === undefined) return { normalized: null, usedPayloadPaths: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Errors.policyExprInvalid("rowFilters 必须是对象");
  const kind = String((input as any).kind ?? "");
  if (kind === "owner_only") return { normalized: { kind: "owner_only" }, usedPayloadPaths: [] };
  if (kind === "payload_field_eq_subject") {
    const field = String((input as any).field ?? "");
    if (!isSafeFieldName(field)) throw Errors.policyExprInvalid("rowFilters.field 非法");
    return { normalized: { kind: "payload_field_eq_subject", field }, usedPayloadPaths: [field] };
  }
  if (kind === "payload_field_eq_literal") {
    const field = String((input as any).field ?? "");
    if (!isSafeFieldName(field)) throw Errors.policyExprInvalid("rowFilters.field 非法");
    const value = (input as any).value;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") throw Errors.policyExprInvalid("rowFilters.value 类型非法");
    return { normalized: { kind: "payload_field_eq_literal", field, value }, usedPayloadPaths: [field] };
  }
  if (kind === "or") {
    const rules = (input as any).rules;
    if (!Array.isArray(rules) || rules.length === 0) throw Errors.policyExprInvalid("rowFilters.or.rules 不能为空");
    const out: any[] = [];
    const paths = new Set<string>();
    for (const r of rules) {
      const sub = normalizeRowFilters(r);
      if (sub.normalized) out.push(sub.normalized);
      for (const p of sub.usedPayloadPaths) paths.add(p);
    }
    return { normalized: { kind: "or", rules: out }, usedPayloadPaths: Array.from(paths) };
  }
  if (kind === "and") {
    const rules = (input as any).rules;
    if (!Array.isArray(rules) || rules.length === 0) throw Errors.policyExprInvalid("rowFilters.and.rules 不能为空");
    const out: any[] = [];
    const paths = new Set<string>();
    for (const r of rules) {
      const sub = normalizeRowFilters(r);
      if (sub.normalized) out.push(sub.normalized);
      for (const p of sub.usedPayloadPaths) paths.add(p);
    }
    return { normalized: { kind: "and", rules: out }, usedPayloadPaths: Array.from(paths) };
  }
  if (kind === "not") {
    const rule = (input as any).rule;
    if (!rule || typeof rule !== "object") throw Errors.policyExprInvalid("rowFilters.not.rule 必须是对象");
    const sub = normalizeRowFilters(rule);
    if (!sub.normalized) throw Errors.policyExprInvalid("rowFilters.not.rule 无效");
    return { normalized: { kind: "not", rule: sub.normalized }, usedPayloadPaths: sub.usedPayloadPaths };
  }
  if (kind === "space_member") {
    const roles = (input as any).roles;
    const normalized: any = { kind: "space_member" };
    if (Array.isArray(roles) && roles.length > 0) {
      normalized.roles = roles.map(String).filter(Boolean);
    }
    return { normalized, usedPayloadPaths: [] };
  }
  if (kind === "org_hierarchy") {
    const orgField = String((input as any).orgField ?? "orgUnitId");
    if (!isSafeFieldName(orgField)) throw Errors.policyExprInvalid("rowFilters.orgField 非法");
    const includeDescendants = Boolean((input as any).includeDescendants ?? true);
    return { normalized: { kind: "org_hierarchy", orgField, includeDescendants }, usedPayloadPaths: [orgField] };
  }
  if (kind === "expr") {
    const v = validatePolicyExpr((input as any).expr);
    if (!v.ok) throw Errors.policyExprInvalid(v.message);
    return { normalized: { kind: "expr", expr: v.expr }, usedPayloadPaths: v.usedPayloadPaths };
  }
  throw Errors.policyExprInvalid(`不支持的 rowFilters.kind：${kind || "unknown"}`);
}

export const rbacRoutes: FastifyPluginAsync = async (app) => {
  app.post("/rbac/policy/preflight", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "policy.preflight" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const body = z.object({ rowFilters: z.any().optional(), fieldRules: z.any().optional() }).parse(req.body);
    const rf = normalizeRowFilters(body.rowFilters);
    req.ctx.audit!.outputDigest = { rowFilters: Boolean(rf.normalized), usedPayloadPathCount: rf.usedPayloadPaths.length };
    return { ok: true, rowFilters: rf.normalized, usedPayloadPaths: rf.usedPayloadPaths, policyExprJsonSchema: POLICY_EXPR_JSON_SCHEMA_V1 };
  });

  app.post("/rbac/roles", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "role.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const body = z.object({ id: z.string().min(1).optional(), name: z.string().min(1) }).parse(req.body);
    const id = body.id ?? `role_${crypto.randomUUID()}`;
    await app.db.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [
      id,
      subject.tenantId,
      body.name,
    ]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = { roleId: id, policyCacheEpochBumped: true, ...epoch };
    return { role: { id, tenantId: subject.tenantId, name: body.name } };
  });

  app.get("/rbac/roles", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "role.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 100;
    const res = await app.db.query("SELECT id, tenant_id, name, created_at FROM roles WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2", [
      subject.tenantId,
      limit,
    ]);
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows };
  });

  app.get("/rbac/roles/:roleId", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const res = await app.db.query("SELECT id, tenant_id, name, created_at FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      subject.tenantId,
      params.roleId,
    ]);
    if (!res.rowCount) throw Errors.badRequest("Role 不存在");
    req.ctx.audit!.outputDigest = { roleId: params.roleId };
    return { role: res.rows[0] };
  });

  app.post("/rbac/permissions", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "permission.register" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const body = z
      .object({
        resourceType: z.string().min(1),
        action: z.string().min(1),
        fieldRulesRead: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        fieldRulesWrite: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        rowFiltersRead: z.any().optional(),
        rowFiltersWrite: z.any().optional(),
      })
      .parse(req.body);
    const res = await app.db.query(
      `
        INSERT INTO permissions (resource_type, action)
        VALUES ($1, $2)
        ON CONFLICT (resource_type, action) DO UPDATE
        SET resource_type = EXCLUDED.resource_type
        RETURNING id
      `,
      [body.resourceType, body.action],
    );
    const actor = req.ctx.subject!;
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: "tenant", scopeId: actor.tenantId });
    req.ctx.audit!.outputDigest = { permissionId: res.rows[0].id, policyCacheEpochBumped: true, ...epoch };
    return { permissionId: res.rows[0].id };
  });

  app.get("/rbac/permissions", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "permission.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 200;
    const res = await app.db.query(
      "SELECT id, resource_type, action, field_rules_read, field_rules_write, row_filters_read, row_filters_write, created_at FROM permissions ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows };
  });

  app.post("/rbac/roles/:roleId/permissions", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.grant" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const body = z
      .object({
        resourceType: z.string().min(1),
        action: z.string().min(1),
        fieldRulesRead: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        fieldRulesWrite: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        rowFiltersRead: z.any().optional(),
        rowFiltersWrite: z.any().optional(),
      })
      .parse(req.body);
    const role = await app.db.query("SELECT 1 FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [subject.tenantId, params.roleId]);
    if (!role.rowCount) throw Errors.badRequest("Role 不存在");
    const permRes = await app.db.query(
      `
        INSERT INTO permissions (resource_type, action)
        VALUES ($1, $2)
        ON CONFLICT (resource_type, action) DO UPDATE
        SET resource_type = EXCLUDED.resource_type
        RETURNING id
      `,
      [body.resourceType, body.action],
    );
    await app.db.query(
      `
        INSERT INTO role_permissions (role_id, permission_id, field_rules_read, field_rules_write, row_filters_read, row_filters_write)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (role_id, permission_id) DO UPDATE
        SET field_rules_read = COALESCE(EXCLUDED.field_rules_read, role_permissions.field_rules_read),
            field_rules_write = COALESCE(EXCLUDED.field_rules_write, role_permissions.field_rules_write),
            row_filters_read = COALESCE(EXCLUDED.row_filters_read, role_permissions.row_filters_read),
            row_filters_write = COALESCE(EXCLUDED.row_filters_write, role_permissions.row_filters_write)
      `,
      [
        params.roleId,
        permRes.rows[0].id,
        body.fieldRulesRead ?? null,
        body.fieldRulesWrite ?? null,
        normalizeRowFilters(body.rowFiltersRead).normalized,
        normalizeRowFilters(body.rowFiltersWrite).normalized,
      ],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = {
      roleId: params.roleId,
      permissionId: permRes.rows[0].id,
      fieldRules: Boolean(body.fieldRulesRead || body.fieldRulesWrite),
      rowFilters: Boolean(body.rowFiltersRead || body.rowFiltersWrite),
      policyCacheEpochBumped: true,
      ...epoch,
    };
    return { ok: true };
  });

  app.delete("/rbac/roles/:roleId/permissions", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.revoke" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const body = z.object({ resourceType: z.string().min(1), action: z.string().min(1) }).parse(req.body);
    const role = await app.db.query("SELECT 1 FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [subject.tenantId, params.roleId]);
    if (!role.rowCount) throw Errors.badRequest("Role 不存在");
    const perm = await app.db.query("SELECT id FROM permissions WHERE resource_type = $1 AND action = $2 LIMIT 1", [body.resourceType, body.action]);
    if (!perm.rowCount) return { ok: true };
    await app.db.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2", [params.roleId, perm.rows[0].id]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = { roleId: params.roleId, permissionId: perm.rows[0].id, policyCacheEpochBumped: true, ...epoch };
    return { ok: true };
  });

  app.post("/rbac/bindings", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "binding.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const actor = req.ctx.subject!;
    const body = z
      .object({
        subjectId: z.string().min(1),
        roleId: z.string().min(1),
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
      })
      .parse(req.body);

    const subjectRes = await app.db.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [body.subjectId]);
    if (!subjectRes.rowCount) throw Errors.badRequest("Subject 不存在");
    if (String(subjectRes.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const roleRes = await app.db.query("SELECT tenant_id FROM roles WHERE id = $1 LIMIT 1", [body.roleId]);
    if (!roleRes.rowCount) throw Errors.badRequest("Role 不存在");
    if (String(roleRes.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    if (body.scopeType === "tenant" && body.scopeId !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (body.scopeType === "space") {
      const spaceRes = await app.db.query("SELECT tenant_id FROM spaces WHERE id = $1 LIMIT 1", [body.scopeId]);
      if (!spaceRes.rowCount) throw Errors.badRequest("Space 不存在");
      if (String(spaceRes.rows[0].tenant_id) !== actor.tenantId) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
    }

    const insert = await app.db.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [body.subjectId, body.roleId, body.scopeType, body.scopeId],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: body.scopeType, scopeId: body.scopeId });
    req.ctx.audit!.outputDigest = { bindingId: insert.rows[0].id, subjectId: body.subjectId, roleId: body.roleId, scopeType: body.scopeType, policyCacheEpochBumped: true, ...epoch };
    return { bindingId: insert.rows[0].id };
  });

  app.delete("/rbac/bindings/:bindingId", async (req) => {
    const params = z.object({ bindingId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "binding.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const actor = req.ctx.subject!;

    const existing = await app.db.query(
      `
        SELECT rb.id, rb.scope_type, rb.scope_id, s.tenant_id
        FROM role_bindings rb
        JOIN subjects s ON s.id = rb.subject_id
        WHERE rb.id = $1
        LIMIT 1
      `,
      [params.bindingId],
    );
    if (!existing.rowCount) return { ok: true };
    if (String(existing.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    await app.db.query("DELETE FROM role_bindings WHERE id = $1", [params.bindingId]);
    const scopeType = String(existing.rows[0].scope_type ?? "");
    const scopeId = String(existing.rows[0].scope_id ?? "");
    const epoch = scopeType === "tenant" || scopeType === "space" ? await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: scopeType as any, scopeId }) : null;
    req.ctx.audit!.outputDigest = { bindingId: params.bindingId, policyCacheEpochBumped: Boolean(epoch), ...(epoch ?? {}) };
    return { ok: true };
  });

  /* ─── ABAC Policies CRUD ─── */

  app.get("/rbac/abac/policies", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 100;
    const res = await app.db.query(
      "SELECT policy_id, tenant_id, policy_name, description, resource_type, action, priority, effect, conditions, enabled, created_by, created_at, updated_at FROM abac_policies WHERE tenant_id = $1 ORDER BY priority ASC, created_at DESC LIMIT $2",
      [subject.tenantId, limit],
    );
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows };
  });

  app.post("/rbac/abac/policies", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const body = z
      .object({
        policyName: z.string().min(1).max(200),
        description: z.any().optional(),
        resourceType: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        priority: z.number().int().min(0).max(10000).optional(),
        effect: z.enum(["deny", "allow"]).optional(),
        conditions: z.array(z.any()).min(1),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    // Validate conditions are parseable
    const parsed = parseAbacConditions(body.conditions);
    if (parsed.length === 0) throw Errors.badRequest("conditions 无效");

    const res = await app.db.query(
      `INSERT INTO abac_policies (tenant_id, policy_name, description, resource_type, action, priority, effect, conditions, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, policy_name) DO UPDATE
       SET description = COALESCE(EXCLUDED.description, abac_policies.description),
           resource_type = EXCLUDED.resource_type,
           action = EXCLUDED.action,
           priority = EXCLUDED.priority,
           effect = EXCLUDED.effect,
           conditions = EXCLUDED.conditions,
           enabled = EXCLUDED.enabled,
           updated_at = now()
       RETURNING policy_id`,
      [
        subject.tenantId,
        body.policyName,
        body.description ? JSON.stringify(body.description) : null,
        body.resourceType ?? "*",
        body.action ?? "*",
        body.priority ?? 100,
        body.effect ?? "deny",
        JSON.stringify(body.conditions),
        body.enabled ?? true,
        subject.subjectId ?? null,
      ],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = { policyId: res.rows[0].policy_id, policyCacheEpochBumped: true, ...epoch };
    return { policyId: res.rows[0].policy_id };
  });

  app.get("/rbac/abac/policies/:policyId", async (req) => {
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const res = await app.db.query(
      "SELECT * FROM abac_policies WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1",
      [subject.tenantId, params.policyId],
    );
    if (!res.rowCount) throw Errors.badRequest("ABAC Policy 不存在");
    req.ctx.audit!.outputDigest = { policyId: params.policyId };
    return { policy: res.rows[0] };
  });

  app.post("/rbac/abac/policies/:policyId/update", async (req) => {
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    const body = z
      .object({
        description: z.any().optional(),
        resourceType: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        priority: z.number().int().min(0).max(10000).optional(),
        effect: z.enum(["deny", "allow"]).optional(),
        conditions: z.array(z.any()).min(1).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);

    if (body.conditions) {
      const parsed = parseAbacConditions(body.conditions);
      if (parsed.length === 0) throw Errors.badRequest("conditions 无效");
    }

    const existing = await app.db.query(
      "SELECT 1 FROM abac_policies WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1",
      [subject.tenantId, params.policyId],
    );
    if (!existing.rowCount) throw Errors.badRequest("ABAC Policy 不存在");

    const sets: string[] = ["updated_at = now()"];
    const args: any[] = [subject.tenantId, params.policyId];
    let idx = 2;
    if (body.description !== undefined) { args.push(JSON.stringify(body.description)); sets.push(`description = $${++idx}`); }
    if (body.resourceType !== undefined) { args.push(body.resourceType); sets.push(`resource_type = $${++idx}`); }
    if (body.action !== undefined) { args.push(body.action); sets.push(`action = $${++idx}`); }
    if (body.priority !== undefined) { args.push(body.priority); sets.push(`priority = $${++idx}`); }
    if (body.effect !== undefined) { args.push(body.effect); sets.push(`effect = $${++idx}`); }
    if (body.conditions !== undefined) { args.push(JSON.stringify(body.conditions)); sets.push(`conditions = $${++idx}`); }
    if (body.enabled !== undefined) { args.push(body.enabled); sets.push(`enabled = $${++idx}`); }

    await app.db.query(`UPDATE abac_policies SET ${sets.join(", ")} WHERE tenant_id = $1 AND policy_id = $2`, args);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = { policyId: params.policyId, policyCacheEpochBumped: true, ...epoch };
    return { ok: true };
  });

  app.delete("/rbac/abac/policies/:policyId", async (req) => {
    const params = z.object({ policyId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const subject = req.ctx.subject!;
    await app.db.query("DELETE FROM abac_policies WHERE tenant_id = $1 AND policy_id = $2", [subject.tenantId, params.policyId]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    req.ctx.audit!.outputDigest = { policyId: params.policyId, policyCacheEpochBumped: true, ...epoch };
    return { ok: true };
  });

  app.post("/rbac/abac/evaluate", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.evaluate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "rbac", action: "manage" });
    const body = z
      .object({
        conditions: z.array(z.any()).min(1),
        context: z
          .object({
            clientIp: z.string().optional(),
            geoRegion: z.string().optional(),
            riskLevel: z.string().optional(),
            dataLabels: z.array(z.string()).optional(),
            deviceType: z.string().optional(),
            attributes: z.record(z.string(), z.any()).optional(),
          })
          .optional(),
        mode: z.enum(["all", "any"]).optional(),
      })
      .parse(req.body);

    const conditions = parseAbacConditions(body.conditions);
    if (conditions.length === 0) throw Errors.badRequest("conditions 无效");

    const ctx: AbacContext = {
      now: new Date(),
      clientIp: body.context?.clientIp,
      geoRegion: body.context?.geoRegion,
      riskLevel: body.context?.riskLevel,
      dataLabels: body.context?.dataLabels,
      deviceType: body.context?.deviceType,
      attributes: body.context?.attributes,
    };

    const result = evaluateAbacPolicy({ conditions, ctx, mode: body.mode ?? "all" });
    req.ctx.audit!.outputDigest = { allowed: result.allowed, evaluatedConditions: result.evaluatedConditions };
    return result;
  });
};
