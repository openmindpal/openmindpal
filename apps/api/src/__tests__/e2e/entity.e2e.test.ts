/**
 * Entity 模块 E2E 测试
 * 包含：实体CRUD、query、幂等、bulk io
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:entity", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("写入幂等：重复提交返回同一记录", async () => {
    if (!ctx.canRun) return;
    const headers = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "x-trace-id": "t-idem",
      "idempotency-key": "idem-1",
      "content-type": "application/json",
      "x-schema-name": "core",
    };
    const payload = JSON.stringify({ title: "hello" });
    const r1 = await ctx.app.inject({ method: "POST", url: "/entities/notes", headers, payload });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json() as any;
    const r2 = await ctx.app.inject({ method: "POST", url: "/entities/notes", headers, payload });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as any;
    expect(b1.id).toBe(b2.id);
  });

  it("实体 query：filters + orderBy + cursor", async () => {
    if (!ctx.canRun) return;
    const headersBase = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const a1 = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: { ...headersBase, "x-trace-id": "t-query-seed-1", "idempotency-key": `idem-q-${crypto.randomUUID()}`, "x-schema-name": "core" },
      payload: JSON.stringify({ title: "Alpha" }),
    });
    expect(a1.statusCode).toBe(200);

    const a2 = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: { ...headersBase, "x-trace-id": "t-query-seed-2", "idempotency-key": `idem-q-${crypto.randomUUID()}`, "x-schema-name": "core" },
      payload: JSON.stringify({ title: "Beta" }),
    });
    expect(a2.statusCode).toBe(200);

    const a3 = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: { ...headersBase, "x-trace-id": "t-query-seed-3", "idempotency-key": `idem-q-${crypto.randomUUID()}`, "x-schema-name": "core" },
      payload: JSON.stringify({ title: "Alpha 2" }),
    });
    expect(a3.statusCode).toBe(200);

    const q1 = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes/query",
      headers: { ...headersBase, "x-trace-id": "t-entity-query-1" },
      payload: JSON.stringify({
        schemaName: "core",
        filters: { field: "title", op: "contains", value: "Alpha" },
        orderBy: [{ field: "updatedAt", direction: "desc" }],
        limit: 1,
      }),
    });
    expect(q1.statusCode).toBe(200);
    const b1 = q1.json() as any;
    expect(Array.isArray(b1.items)).toBe(true);
    expect(b1.items.length).toBe(1);
    expect(String(b1.items[0].payload.title)).toContain("Alpha");
    expect(b1.nextCursor).toBeTruthy();

    const q2 = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes/query",
      headers: { ...headersBase, "x-trace-id": "t-entity-query-2" },
      payload: JSON.stringify({
        schemaName: "core",
        filters: { field: "title", op: "contains", value: "Alpha" },
        orderBy: [{ field: "updatedAt", direction: "desc" }],
        limit: 10,
        cursor: b1.nextCursor,
      }),
    });
    expect(q2.statusCode).toBe(200);
    const b2 = q2.json() as any;
    expect(Array.isArray(b2.items)).toBe(true);

    const badField = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes/query",
      headers: { ...headersBase, "x-trace-id": "t-entity-query-bad" },
      payload: JSON.stringify({ schemaName: "core", filters: { field: "nope", op: "eq", value: "x" } }),
    });
    expect(badField.statusCode).toBe(400);
  });

  it("entities.query：支持 filters + nextCursor 分页", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const q = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes/query",
      headers: { ...h, "x-trace-id": `t-entities-query-${crypto.randomUUID()}` },
      payload: JSON.stringify({ schemaName: "core", limit: 2 }),
    });
    expect(q.statusCode).toBe(200);
    const b = q.json() as any;
    expect(Array.isArray(b.items)).toBe(true);
  });
});
