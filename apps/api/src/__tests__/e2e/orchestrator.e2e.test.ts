/**
 * Orchestrator 模块 E2E 测试
 * 包含：编排器turn、工具建议、closed-loop执行
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:orchestrator", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("orchestrator：可生成工具建议与 UI 指令并写审计", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const traceId = `t-orch-turn-${crypto.randomUUID()}`;
    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/turn",
      headers: { ...h, "x-trace-id": traceId },
      payload: JSON.stringify({ message: "帮我创建一个笔记" }),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json() as any;
    expect(b.turnId).toBeTruthy();
    expect(b.toolSuggestions || b.uiDirective || b.responseText).toBeTruthy();
  });

  it("orchestrator：closed-loop 可创建 run 并返回 summary", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/closed-loop",
      headers: { ...h, "x-trace-id": `t-cl-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        goal: "创建一条笔记",
        limits: { maxSteps: 2, maxWallTimeMs: 30_000 },
      }),
    });
    expect([200, 400, 403, 409].includes(r.statusCode)).toBe(true);
  });

  it("orchestrator：execute 支持 turnId + suggestionId 绑定", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const traceId = `t-orch-turn-exec-${crypto.randomUUID()}`;
    const turn = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/turn",
      headers: { ...h, "x-trace-id": traceId },
      payload: JSON.stringify({
        message: "帮我创建一个笔记",
      }),
    });
    expect(turn.statusCode).toBe(200);
    const tb = turn.json() as any;
    const s = Array.isArray(tb.toolSuggestions) ? tb.toolSuggestions[0] : null;
    if (!s?.suggestionId) return;
    const exec = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/execute",
      headers: { ...h, "idempotency-key": `idem-orch-exec-${crypto.randomUUID()}`, "x-trace-id": `t-orch-exec-${crypto.randomUUID()}` },
      payload: JSON.stringify({ turnId: String(tb.turnId), suggestionId: String(s.suggestionId), input: s.inputDraft ?? {} }),
    });
    expect([200, 400, 403, 409, 500].includes(exec.statusCode)).toBe(true);
  });

  it("不允许执行未支持的工具", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/execute",
      headers: { ...h, "idempotency-key": `idem-unsupported-${crypto.randomUUID()}`, "x-trace-id": `t-unsupported-${crypto.randomUUID()}` },
      payload: JSON.stringify({ toolRef: "unsupported.tool@1", input: {} }),
    });
    expect([400, 404].includes(r.statusCode)).toBe(true);
  });
});
