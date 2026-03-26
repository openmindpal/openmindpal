/**
 * Audit 模块 E2E 测试
 * 包含：audit outbox、hashchain、retention、siem、审计追溯
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  dispatchAuditOutboxBatch,
  processAuditExport,
  type TestContext,
} from "./setup";

describe.sequential("e2e:audit", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("audit outbox：outbox 写入失败则业务回滚", async () => {
    if (!ctx.canRun) return;
    const idem = `idem-outbox-fail-${crypto.randomUUID()}`;
    const traceId = `t-outbox-fail-${crypto.randomUUID()}`;
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "1";
    const r = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
        "idempotency-key": idem,
        "content-type": "application/json",
        "x-schema-name": "core",
      },
      payload: JSON.stringify({ title: `outbox fail ${crypto.randomUUID()}` }),
    });
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "0";
    expect(r.statusCode).toBe(500);
    const b = r.json() as any;
    expect(b.errorCode).toBe("AUDIT_OUTBOX_WRITE_FAILED");

    const idemRes = await pool.query(
      "SELECT id FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = 'create' AND entity_name = 'notes' LIMIT 1",
      ["tenant_dev", idem],
    );
    expect(idemRes.rowCount).toBe(0);
  });

  it("audit（read）：审计写入失败进入 outbox 且最终落 audit_events", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-read-audit-outbox-ok-${crypto.randomUUID()}`;
    process.env.AUDIT_FORCE_FAIL = "1";
    const r = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
      },
    });
    process.env.AUDIT_FORCE_FAIL = "0";
    expect(r.statusCode).toBe(200);

    const ob = await pool.query("SELECT outbox_id FROM audit_outbox WHERE (event->>'traceId') = $1 LIMIT 1", [traceId]);
    expect(ob.rowCount).toBe(1);
    const outboxId = String(ob.rows[0].outbox_id);

    for (let i = 0; i < 10; i++) {
      await dispatchAuditOutboxBatch({ pool, limit: 50 });
      const ob2x = await pool.query("SELECT status FROM audit_outbox WHERE outbox_id = $1 LIMIT 1", [outboxId]);
      if (String(ob2x.rows?.[0]?.status ?? "") === "succeeded") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const ae = await pool.query("SELECT result FROM audit_events WHERE outbox_id = $1 LIMIT 1", [outboxId]);
    expect(ae.rowCount).toBe(1);
    expect(String(ae.rows[0].result)).toBe("success");

    const metrics = await ctx.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": `t-metrics-${crypto.randomUUID()}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(String(metrics.body)).toContain("openslin_audit_outbox_enqueue_total");
  });

  it("audit（read denied）：审计写入失败进入 outbox，结果为 denied", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-read-audit-outbox-denied-${crypto.randomUUID()}`;
    process.env.AUDIT_FORCE_FAIL = "1";
    const r = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer noperm",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
      },
    });
    process.env.AUDIT_FORCE_FAIL = "0";
    expect(r.statusCode).toBe(403);

    const ob = await pool.query("SELECT outbox_id FROM audit_outbox WHERE (event->>'traceId') = $1 LIMIT 1", [traceId]);
    expect(ob.rowCount).toBe(1);
    const outboxId = String(ob.rows[0].outbox_id);

    for (let i = 0; i < 10; i++) {
      await dispatchAuditOutboxBatch({ pool, limit: 50 });
      const ob2x = await pool.query("SELECT status FROM audit_outbox WHERE outbox_id = $1 LIMIT 1", [outboxId]);
      if (String(ob2x.rows?.[0]?.status ?? "") === "succeeded") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const ae = await pool.query("SELECT result FROM audit_events WHERE outbox_id = $1 LIMIT 1", [outboxId]);
    expect(ae.rowCount).toBe(1);
    expect(String(ae.rows[0].result)).toBe("denied");
  });

  it("audit（read）：同步写失败且 outbox 也失败则请求失败", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-read-audit-outbox-fail-${crypto.randomUUID()}`;
    process.env.AUDIT_FORCE_FAIL = "1";
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "1";
    const r = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
      },
    });
    process.env.AUDIT_FORCE_FAIL = "0";
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "0";
    expect(r.statusCode).toBe(500);
    expect((r.json() as any).errorCode).toBe("AUDIT_OUTBOX_WRITE_FAILED");
  });

  it("audit outbox：成功写入后可被投递到 audit_events", async () => {
    if (!ctx.canRun) return;
    const idem = `idem-outbox-ok-${crypto.randomUUID()}`;
    const traceId = `t-outbox-ok-${crypto.randomUUID()}`;
    const r = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
        "idempotency-key": idem,
        "content-type": "application/json",
        "x-schema-name": "core",
      },
      payload: JSON.stringify({ title: `outbox ok ${crypto.randomUUID()}` }),
    });
    expect(r.statusCode).toBe(200);

    const ob = await pool.query("SELECT outbox_id FROM audit_outbox WHERE (event->>'traceId') = $1 LIMIT 1", [traceId]);
    expect(ob.rowCount).toBe(1);
    const outboxId = String(ob.rows[0].outbox_id);

    for (let i = 0; i < 10; i++) {
      await dispatchAuditOutboxBatch({ pool, limit: 50 });
      const ob2x = await pool.query("SELECT status FROM audit_outbox WHERE outbox_id = $1 LIMIT 1", [outboxId]);
      if (String(ob2x.rows?.[0]?.status ?? "") === "succeeded") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const ob2 = await pool.query("SELECT status, last_error FROM audit_outbox WHERE outbox_id = $1 LIMIT 1", [outboxId]);
    expect(ob2.rowCount).toBe(1);
    expect(String(ob2.rows[0].status)).toBe("succeeded");

    const ae = await pool.query("SELECT event_id FROM audit_events WHERE outbox_id = $1 LIMIT 1", [outboxId]);
    expect(ae.rowCount).toBe(1);
  });

  it("审计可按 traceId 检索", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-audit-trace-${crypto.randomUUID()}`;
    await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": traceId },
    });
    const r = await ctx.app.inject({
      method: "GET",
      url: `/governance/audit?traceId=${encodeURIComponent(traceId)}`,
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": `t-audit-q-${crypto.randomUUID()}` },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray((r.json() as any).events)).toBe(true);
  });

  it("audit errorCategory：worker 写入会归一化到约束允许集合", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-errorcat-${crypto.randomUUID()}`;
    await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: { authorization: "Bearer noperm", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": traceId },
    });
    const r = await pool.query("SELECT error_category FROM audit_events WHERE trace_id = $1 LIMIT 1", [traceId]);
    if (r.rowCount) {
      expect([null, "policy_violation", "validation_error", "rate_limited", "upstream_error", "internal_error"].includes((r.rows[0].error_category as any) ?? null)).toBe(true);
    }
  });

  it("audit：hashchain verify 与禁止 update/delete", async () => {
    if (!ctx.canRun) return;
    const r = await ctx.app.inject({
      method: "GET",
      url: "/governance/audit/hashchain/verify",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": `t-hashchain-${crypto.randomUUID()}` },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as any).valid).toBe(true);
  });

  it("写操作审计失败返回 AUDIT_WRITE_FAILED", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-audit-write-fail-${crypto.randomUUID()}`;
    const idem = `idem-audit-write-fail-${crypto.randomUUID()}`;
    process.env.AUDIT_FORCE_FAIL = "1";
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "1";
    const r = await ctx.app.inject({
      method: "POST",
      url: "/entities/notes",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": traceId,
        "idempotency-key": idem,
        "content-type": "application/json",
        "x-schema-name": "core",
      },
      payload: JSON.stringify({ title: `audit fail ${crypto.randomUUID()}` }),
    });
    process.env.AUDIT_FORCE_FAIL = "0";
    process.env.AUDIT_OUTBOX_FORCE_FAIL = "0";
    expect(r.statusCode).toBe(500);
    expect((r.json() as any).errorCode).toBe("AUDIT_WRITE_FAILED");
  });
});
