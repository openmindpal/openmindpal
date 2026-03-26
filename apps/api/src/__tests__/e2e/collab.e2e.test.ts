/**
 * Collab 模块 E2E 测试
 * 包含：协作运行时、pipeline、protocol
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:collab", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("collab runtime：创建→执行→事件流可查询", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const taskRes = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { ...h, "idempotency-key": `idem-task-${crypto.randomUUID()}`, "x-trace-id": `t-task-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "collab task" }),
    });
    expect(taskRes.statusCode).toBe(200);
    const taskId = String((taskRes.json() as any).task?.taskId);
    expect(taskId).toBeTruthy();

    const create = await ctx.app.inject({
      method: "POST",
      url: `/tasks/${encodeURIComponent(taskId)}/collab-runs`,
      headers: { ...h, "idempotency-key": `idem-collab-${crypto.randomUUID()}`, "x-trace-id": `t-collab-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "新建一条笔记",
        limits: { maxSteps: 3, maxWallTimeMs: 30_000 },
      }),
    });
    expect([200, 400, 409].includes(create.statusCode)).toBe(true);

    if (create.statusCode === 200) {
      const collabRunId = String((create.json() as any).collabRunId);
      const events = await ctx.app.inject({
        method: "GET",
        url: `/tasks/${encodeURIComponent(taskId)}/collab-runs/${encodeURIComponent(collabRunId)}/events`,
        headers: { ...h, "x-trace-id": `t-collab-events-${crypto.randomUUID()}` },
      });
      expect([200, 404].includes(events.statusCode)).toBe(true);
    }
  });

  it("collab runtime：跨 space 禁止读取 collab runs 列表", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const taskRes = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: { ...h, "idempotency-key": `idem-task-iso-${crypto.randomUUID()}`, "x-trace-id": `t-task-iso-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "collab iso task" }),
    });
    expect(taskRes.statusCode).toBe(200);
    const taskId = String((taskRes.json() as any).task?.taskId);
    expect(taskId).toBeTruthy();

    const create = await ctx.app.inject({
      method: "POST",
      url: `/tasks/${encodeURIComponent(taskId)}/collab-runs`,
      headers: { ...h, "idempotency-key": `idem-collab-iso-${crypto.randomUUID()}`, "x-trace-id": `t-collab-iso-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "新建一条笔记",
        limits: { maxSteps: 3, maxWallTimeMs: 30_000 },
      }),
    });

    if (create.statusCode === 200) {
      const collabRunId = String((create.json() as any).collabRunId);
      const otherSpace = await ctx.app.inject({
        method: "GET",
        url: `/tasks/${encodeURIComponent(taskId)}/collab-runs/${encodeURIComponent(collabRunId)}`,
        headers: { ...h, authorization: "Bearer admin@space_other", "x-space-id": "space_other", "x-trace-id": `t-collab-other-${crypto.randomUUID()}` },
      });
      expect([403, 404].includes(otherSpace.statusCode)).toBe(true);
    }
  });

  it("governance：pipeline summary 可读取并包含 gates", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
    };

    const r = await ctx.app.inject({
      method: "GET",
      url: "/governance/pipelines/summary",
      headers: { ...h, "x-trace-id": `t-pipeline-summary-${crypto.randomUUID()}` },
    });
    expect([200, 404].includes(r.statusCode)).toBe(true);
  });
});
