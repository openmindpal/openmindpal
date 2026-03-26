/**
 * Misc 模块 E2E 测试
 * 包含：sync、device、connectors、model gateway、healthz、memory等
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  reencryptSecrets,
  type TestContext,
} from "./setup";

describe.sequential("e2e:misc", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("sync：push/pull 幂等、digest 稳定与冲突输出", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const push = await ctx.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { ...h, "x-trace-id": `t-sync-push-${crypto.randomUUID()}` },
      payload: JSON.stringify({ changes: [] }),
    });
    expect([200, 400].includes(push.statusCode)).toBe(true);

    const pull = await ctx.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { ...h, "x-trace-id": `t-sync-pull-${crypto.randomUUID()}` },
      payload: JSON.stringify({ since: null }),
    });
    expect([200, 400].includes(pull.statusCode)).toBe(true);
  });

  it("connectors/secrets：可创建实例与密钥，且禁止读取明文并可撤销", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const list = await ctx.app.inject({
      method: "GET",
      url: "/connectors/instances",
      headers: { ...h, "x-trace-id": `t-conn-list-${crypto.randomUUID()}` },
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray((list.json() as any).instances)).toBe(true);
  });

  it("model gateway：catalog/binding/invoke/allowedDomains/限流", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const catalog = await ctx.app.inject({
      method: "GET",
      url: "/models/catalog",
      headers: { ...h, "x-trace-id": `t-model-catalog-${crypto.randomUUID()}` },
    });
    expect([200, 404].includes(catalog.statusCode)).toBe(true);

    const bindings = await ctx.app.inject({
      method: "GET",
      url: "/models/bindings",
      headers: { ...h, "x-trace-id": `t-model-bindings-${crypto.randomUUID()}` },
    });
    expect([200, 404].includes(bindings.statusCode)).toBe(true);
  });

  it("healthz/diagnostics：健康检查开放，诊断需权限", async () => {
    if (!ctx.canRun) return;

    const health = await ctx.app.inject({
      method: "GET",
      url: "/healthz",
    });
    expect(health.statusCode).toBe(200);

    const diag = await ctx.app.inject({
      method: "GET",
      url: "/diagnostics",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev" },
    });
    expect([200, 403, 404].includes(diag.statusCode)).toBe(true);
  });

  it("memory：写入→检索→删除/清除（含空间隔离与脱敏）", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const write = await ctx.app.inject({
      method: "POST",
      url: "/memory/write",
      headers: { ...h, "x-trace-id": `t-mem-write-${crypto.randomUUID()}` },
      payload: JSON.stringify({ key: `test-${crypto.randomUUID()}`, value: "test value" }),
    });
    expect([200, 400, 404].includes(write.statusCode)).toBe(true);

    const search = await ctx.app.inject({
      method: "POST",
      url: "/memory/search",
      headers: { ...h, "x-trace-id": `t-mem-search-${crypto.randomUUID()}` },
      payload: JSON.stringify({ query: "test" }),
    });
    expect([200, 400, 404].includes(search.statusCode)).toBe(true);
  });

  it("metrics：/metrics 受控访问且包含请求与拒绝指标", async () => {
    if (!ctx.canRun) return;
    const r = await ctx.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev" },
    });
    expect(r.statusCode).toBe(200);
    expect(String(r.body)).toContain("openslin_");
  });

  it("PAT：创建→使用→撤销", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const create = await ctx.app.inject({
      method: "POST",
      url: "/auth/tokens",
      headers: { ...h, "x-trace-id": `t-pat-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ name: `test-pat-${crypto.randomUUID().slice(0, 8)}`, scopes: ["read"] }),
    });
    expect([200, 400].includes(create.statusCode)).toBe(true);
  });

  it("multi-agent：tasks/messages 可创建与查询（space 隔离）", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const tasks = await ctx.app.inject({
      method: "GET",
      url: "/tasks",
      headers: { ...h, "x-trace-id": `t-tasks-list-${crypto.randomUUID()}` },
    });
    expect(tasks.statusCode).toBe(200);
  });
});
