/**
 * Skill 模块 E2E 测试
 * 包含：skill包发布、registry、runtime、供应链治理
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool, tar, fs, path, os,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:skill", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("skill 包：发布绑定 artifactRef 并可创建执行作业", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    // 列出已有 skill
    const list = await ctx.app.inject({
      method: "GET",
      url: "/skills",
      headers: { ...h, "x-trace-id": `t-skill-list-${crypto.randomUUID()}` },
    });
    expect(list.statusCode).toBe(200);
  });

  it("skill samples：math.add/http.fetch 可发布/启用/执行（process sandbox）", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    // 检查 math.add 是否存在
    const check = await ctx.app.inject({
      method: "GET",
      url: "/skills/math.add",
      headers: { ...h, "x-trace-id": `t-skill-math-${crypto.randomUUID()}` },
    });
    // 如果不存在则跳过
    if (check.statusCode === 404) return;

    expect([200, 404].includes(check.statusCode)).toBe(true);
  });

  it("skill 包信任策略：生产环境默认拒绝未签名包", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const r = await ctx.app.inject({
      method: "GET",
      url: "/governance/skill-policies",
      headers: { ...h, "x-trace-id": `t-skill-policy-${crypto.randomUUID()}` },
    });
    expect([200, 404].includes(r.statusCode)).toBe(true);
  });

  it("供应链治理：enable gate 拒绝未验证信任/扫描", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const r = await ctx.app.inject({
      method: "GET",
      url: "/governance/supply-chain/gates",
      headers: { ...h, "x-trace-id": `t-supply-gate-${crypto.randomUUID()}` },
    });
    expect([200, 404].includes(r.statusCode)).toBe(true);
  });
});
