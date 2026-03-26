/**
 * RBAC/ABAC 模块 E2E 测试
 * 包含：角色管理、权限授予、绑定、字段级/行级规则
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:rbac", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("rbac：创建 role→授权→绑定→放行；解绑→拒绝；deny 也有 snapshotRef", async () => {
    if (!ctx.canRun) return;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["user1", "tenant_dev"]);
    await pool.query(
      `
        DELETE FROM role_bindings
        WHERE subject_id = 'user1'
          AND NOT (role_id = 'role_user' AND scope_type = 'tenant' AND scope_id = 'tenant_dev')
      `,
    );
    await pool.query(
      `
        DELETE FROM role_permissions rp
        USING permissions p
        WHERE rp.role_id = 'role_user'
          AND rp.permission_id = p.id
          AND (p.resource_type = 'backup' OR p.resource_type = '*' OR p.action = '*')
      `,
    );

    const denied = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-denied" },
    });
    expect(denied.statusCode).toBe(403);

    const deniedAudit = await ctx.app.inject({
      method: "GET",
      url: "/audit?traceId=t-rbac-denied&limit=5",
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-denied-audit" },
    });
    expect(deniedAudit.statusCode).toBe(200);
    const deniedEvents = (deniedAudit.json() as any).events as any[];
    const deniedSnapRef = deniedEvents?.[0]?.policy_decision?.snapshotRef as string | undefined;
    expect(String(deniedSnapRef)).toContain("policy_snapshot:");
    const deniedSnapId = String(deniedSnapRef).split("policy_snapshot:")[1];
    const deniedSnap = await ctx.app.inject({
      method: "GET",
      url: `/policy-snapshots/${encodeURIComponent(deniedSnapId)}`,
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-denied-snap" },
    });
    expect(deniedSnap.statusCode).toBe(200);

    const roleCreate = await ctx.app.inject({
      method: "POST",
      url: "/rbac/roles",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-role-create" },
      payload: JSON.stringify({ name: "BackupReader" }),
    });
    expect(roleCreate.statusCode).toBe(200);
    const roleId = (roleCreate.json() as any).role.id as string;

    const grant = await ctx.app.inject({
      method: "POST",
      url: `/rbac/roles/${encodeURIComponent(roleId)}/permissions`,
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-grant" },
      payload: JSON.stringify({ resourceType: "backup", action: "list" }),
    });
    expect(grant.statusCode).toBe(200);

    const bind = await ctx.app.inject({
      method: "POST",
      url: "/rbac/bindings",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-bind" },
      payload: JSON.stringify({ subjectId: "user1", roleId, scopeType: "space", scopeId: "space_dev" }),
    });
    expect(bind.statusCode).toBe(200);
    const bindingId = (bind.json() as any).bindingId as string;
    expect(bindingId).toBeTruthy();

    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-allowed" },
    });
    expect(allowed.statusCode).toBe(200);

    const unbind = await ctx.app.inject({
      method: "DELETE",
      url: `/rbac/bindings/${encodeURIComponent(bindingId)}`,
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-unbind" },
    });
    expect(unbind.statusCode).toBe(200);

    const denied2 = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-denied-2" },
    });
    expect(denied2.statusCode).toBe(403);
  });

  it("rbac ui：roles/permissions 基础读写链路可用", async () => {
    if (!ctx.canRun) return;
    const h = { authorization: "Bearer admin", "content-type": "application/json" };

    const roles = await ctx.app.inject({
      method: "GET",
      url: "/rbac/roles",
      headers: { ...h, "x-trace-id": `t-rbac-ui-roles-${crypto.randomUUID()}` },
    });
    expect(roles.statusCode).toBe(200);
    expect(Array.isArray((roles.json() as any).roles)).toBe(true);

    const perms = await ctx.app.inject({
      method: "GET",
      url: "/rbac/permissions",
      headers: { ...h, "x-trace-id": `t-rbac-ui-perms-${crypto.randomUUID()}` },
    });
    expect(perms.statusCode).toBe(200);
    expect(Array.isArray((perms.json() as any).permissions)).toBe(true);
  });
});
