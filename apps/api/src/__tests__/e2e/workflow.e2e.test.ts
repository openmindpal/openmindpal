/**
 * Workflow 模块 E2E 测试
 * 包含：工作流审批、步骤执行、deadletter
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  processStep,
  type TestContext,
} from "./setup";

describe.sequential("e2e:workflow", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("workflow：run 创建幂等与 cancel", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const idem = `idem-run-${crypto.randomUUID()}`;

    const create1 = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/notes/create",
      headers: { ...h, "idempotency-key": idem, "x-schema-name": "core", "x-trace-id": `t-run-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "wf" }),
    });
    expect(create1.statusCode).toBe(200);
    const runId = String((create1.json() as any).runId);

    const create2 = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/notes/create",
      headers: { ...h, "idempotency-key": idem, "x-schema-name": "core", "x-trace-id": `t-run-create-dup-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "wf" }),
    });
    expect(create2.statusCode).toBe(200);
    expect(String((create2.json() as any).runId)).toBe(runId);

    const cancel = await ctx.app.inject({
      method: "POST",
      url: `/runs/${encodeURIComponent(runId)}/cancel`,
      headers: { ...h, "x-trace-id": `t-run-cancel-${crypto.randomUUID()}` },
      payload: "{}",
    });
    expect([200, 409].includes(cancel.statusCode)).toBe(true);
  });

  it("workflow：run retry + space 隔离", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const create = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/notes/create",
      headers: { ...h, "idempotency-key": `idem-retry-${crypto.randomUUID()}`, "x-schema-name": "core", "x-trace-id": `t-run-retry-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "retry" }),
    });
    expect(create.statusCode).toBe(200);
    const runId = String((create.json() as any).runId);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/runs/${encodeURIComponent(runId)}`,
      headers: { ...h, "x-trace-id": `t-run-get-${crypto.randomUUID()}` },
    });
    expect(get.statusCode).toBe(200);

    // space 隔离测试
    const otherSpace = await ctx.app.inject({
      method: "GET",
      url: `/runs/${encodeURIComponent(runId)}`,
      headers: { ...h, authorization: "Bearer admin@space_other", "x-space-id": "space_other", "x-trace-id": `t-run-other-space-${crypto.randomUUID()}` },
    });
    expect([403, 404].includes(otherSpace.statusCode)).toBe(true);
  });

  it("workflow：steps 返回 policySnapshotRef", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const create = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/notes/create",
      headers: { ...h, "idempotency-key": `idem-steps-${crypto.randomUUID()}`, "x-schema-name": "core", "x-trace-id": `t-steps-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "steps" }),
    });
    expect(create.statusCode).toBe(200);
    const jobId = String((create.json() as any).jobId);

    const stepsRes = await ctx.app.inject({
      method: "GET",
      url: `/jobs/${encodeURIComponent(jobId)}`,
      headers: { ...h, "x-trace-id": `t-run-steps-${crypto.randomUUID()}` },
    });
    expect(stepsRes.statusCode).toBe(200);
    const steps = (stepsRes.json() as any).steps as any[];
    expect(Array.isArray(steps)).toBe(true);
    expect(steps[0]?.policySnapshotRef).toBeTruthy();
  });

  it("workflow：补偿记录可查询", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
    };
    const created = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/notes/create",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "content-type": "application/json", "idempotency-key": `idem-comp-${crypto.randomUUID()}`, "x-schema-name": "core", "x-trace-id": `t-comp-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "comp" }),
    });
    expect(created.statusCode).toBe(200);
    const jobId = String((created.json() as any).jobId);
    const job = await ctx.app.inject({ method: "GET", url: `/jobs/${encodeURIComponent(jobId)}`, headers: { ...h, "x-trace-id": `t-comp-job-${crypto.randomUUID()}` } });
    expect(job.statusCode).toBe(200);
    const stepId = String(((job.json() as any).steps?.[0]?.stepId ?? ""));
    expect(stepId).toBeTruthy();

    const r = await ctx.app.inject({
      method: "GET",
      url: `/governance/workflow/steps/${encodeURIComponent(stepId)}/compensations`,
      headers: { ...h, "x-trace-id": `t-comp-${crypto.randomUUID()}` },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray((r.json() as any).items)).toBe(true);
  });
});
