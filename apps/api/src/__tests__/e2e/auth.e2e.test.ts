/**
 * Auth 模块 E2E 测试
 * 包含：认证、HMAC token、PAT、OAuth 等
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext, closePool,
  makeHeaders,
  type TestContext,
} from "./setup";

describe.sequential("e2e:auth", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("拒绝未认证的 schema 读取", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({ method: "GET", url: "/schemas", headers: { "x-trace-id": "t-unauth" } });
    expect(res.statusCode).toBe(401);
  });

  it("忽略租户注入且回显 requestId", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_evil",
        "x-space-id": "space_evil",
        "x-trace-id": "t-me",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(String(body.requestId ?? "")).toMatch(/./);
    expect(body.subject?.tenantId).toBe("tenant_dev");
    expect(body.subject?.spaceId).toBe("space_dev");
  });

  it("authn：hmac token 校验、上下文绑定与 subject 自动落库", async () => {
    if (!ctx.canRun) return;
    const prevMode = process.env.AUTHN_MODE;
    const prevSecret = process.env.AUTHN_HMAC_SECRET;
    process.env.AUTHN_MODE = "hmac";
    process.env.AUTHN_HMAC_SECRET = "s";
    try {
      const now = Math.floor(Date.now() / 1000);
      const payloadPart = Buffer.from(JSON.stringify({ tenantId: "tenant_dev", subjectId: "admin", spaceId: "space_other", exp: now + 60 }), "utf8").toString(
        "base64url",
      );
      const sigPart = crypto.createHmac("sha256", "s").update(payloadPart, "utf8").digest("base64url");
      const token = `${payloadPart}.${sigPart}`;

      const ok = await ctx.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}`, "x-trace-id": "t-authn-hmac-ok" },
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json() as any;
      expect(body.subject?.tenantId).toBe("tenant_dev");
      expect(body.subject?.spaceId).toBe("space_other");

      const p2 = Buffer.from(JSON.stringify({ tenantId: "tenant_dev", subjectId: "hmac_user1", spaceId: "space_dev", exp: now + 60 }), "utf8").toString(
        "base64url",
      );
      const s2 = crypto.createHmac("sha256", "s").update(p2, "utf8").digest("base64url");
      const token2 = `${p2}.${s2}`;
      const ok2 = await ctx.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token2}`, "x-trace-id": "t-authn-hmac-user" },
      });
      expect(ok2.statusCode).toBe(200);
      const sRow = await pool.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", ["hmac_user1"]);
      expect(sRow.rowCount).toBe(1);
      expect(String(sRow.rows[0].tenant_id)).toBe("tenant_dev");

      const bad = await ctx.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer admin", "x-trace-id": "t-authn-hmac-bad" },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
      if (prevSecret === undefined) delete process.env.AUTHN_HMAC_SECRET;
      else process.env.AUTHN_HMAC_SECRET = prevSecret;
    }
  });
});
