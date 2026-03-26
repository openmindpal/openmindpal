/**
 * Schema 模块 E2E 测试
 * 包含：schema读取、effective schema、changeset、发布回滚
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  makeHeaders,
  type TestContext,
} from "./setup";

describe.sequential("e2e:schema", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("可读取 schemas 列表并包含 core", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": "t-schemas",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(String(body.requestId ?? "")).toMatch(/./);
    expect(Array.isArray(body.schemas)).toBe(true);
    expect(body.schemas.some((s: any) => s.name === "core")).toBe(true);
  });

  it("effective schema 可返回字段列表", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas/notes/effective?schemaName=core",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": "t-effective",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.entityName).toBe("notes");
    expect(body.fields?.title).toBeTruthy();
  });

  it("schema active：仅 changeset 可切换/回滚，effective 与写入校验随 active 生效", async () => {
    if (!ctx.canRun) return;
    const schemaName = `test_active_${crypto.randomUUID().slice(0, 8)}`;
    const entityName = "titems";

    const v1 = {
      name: schemaName,
      version: 1,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
          },
        },
      },
    };
    const v2 = {
      name: schemaName,
      version: 2,
      entities: {
        [entityName]: {
          displayName: { "zh-CN": "测试实体", "en-US": "Test Entity" },
          fields: {
            a: { type: "string", required: true },
            b: { type: "string", required: true },
          },
        },
      },
    };

    await pool.query("INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, 1, 'released', $2, now())", [
      schemaName,
      v1,
    ]);
    await pool.query("INSERT INTO schemas (name, version, status, schema_json, published_at) VALUES ($1, 2, 'released', $2, now())", [
      schemaName,
      v2,
    ]);

    const headers = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const actionHeaders = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
    };

    const directSet = await ctx.app.inject({
      method: "POST",
      url: `/governance/schemas/${encodeURIComponent(schemaName)}/set-active`,
      headers: { ...headers, "x-trace-id": `t-schema-active-${crypto.randomUUID()}` },
      payload: JSON.stringify({ version: 1 }),
    });
    expect(directSet.statusCode).toBe(409);
    expect((directSet.json() as any).errorCode).toBe("SCHEMA_CHANGESET_REQUIRED");

    const directRollback = await ctx.app.inject({
      method: "POST",
      url: `/governance/schemas/${encodeURIComponent(schemaName)}/rollback`,
      headers: { ...headers, "x-trace-id": `t-schema-rb-direct-${crypto.randomUUID()}` },
      payload: JSON.stringify({ scopeType: "tenant" }),
    });
    expect(directRollback.statusCode).toBe(409);
    expect((directRollback.json() as any).errorCode).toBe("SCHEMA_CHANGESET_REQUIRED");

    // 通过 changeset 设置 v1 为 active
    const csSetV1 = await ctx.app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-schema-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema set v1 ${schemaName}`, scope: "tenant" }),
    });
    expect(csSetV1.statusCode).toBe(200);
    const csSetV1Id = String((csSetV1.json() as any).changeset.id);

    const csSetV1Item = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV1Id)}/items`,
      headers: { ...headers, "x-trace-id": `t-schema-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.set_active", name: schemaName, version: 1 }),
    });
    expect(csSetV1Item.statusCode).toBe(200);

    const csSetV1Submit = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV1Id)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-submit-${crypto.randomUUID()}` },
    });
    expect(csSetV1Submit.statusCode).toBe(200);

    const csSetV1Approve = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV1Id)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-approve-${crypto.randomUUID()}` },
    });
    expect(csSetV1Approve.statusCode).toBe(200);
    const csSetV1Approve2 = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV1Id)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-schema-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(csSetV1Approve2.statusCode).toBe(200);

    const csSetV1Release = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV1Id)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-release-${crypto.randomUUID()}` },
    });
    expect(csSetV1Release.statusCode).toBe(200);

    const latestAfterV1 = await ctx.app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(schemaName)}/latest`,
      headers: { ...headers, "x-trace-id": `t-schema-latest-${crypto.randomUUID()}` },
    });
    expect(latestAfterV1.statusCode).toBe(200);
    expect((latestAfterV1.json() as any).version).toBe(1);

    const effectiveV1 = await ctx.app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(entityName)}/effective?schemaName=${encodeURIComponent(schemaName)}`,
      headers: { ...headers, "x-trace-id": `t-schema-effective-${crypto.randomUUID()}` },
    });
    expect(effectiveV1.statusCode).toBe(200);
    expect((effectiveV1.json() as any).fields?.b).toBe(undefined);

    const okWrite = await ctx.app.inject({
      method: "POST",
      url: `/entities/${encodeURIComponent(entityName)}`,
      headers: { ...headers, "x-trace-id": `t-schema-write-1-${crypto.randomUUID()}`, "idempotency-key": `idem-${crypto.randomUUID()}`, "x-schema-name": schemaName },
      payload: JSON.stringify({ a: "x" }),
    });
    expect(okWrite.statusCode).toBe(200);

    // 通过 changeset 切换到 v2
    const csSetV2 = await ctx.app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-schema-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema set v2 ${schemaName}`, scope: "tenant" }),
    });
    expect(csSetV2.statusCode).toBe(200);
    const csSetV2Id = String((csSetV2.json() as any).changeset.id);

    const csSetV2Item = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV2Id)}/items`,
      headers: { ...headers, "x-trace-id": `t-schema-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.set_active", name: schemaName, version: 2 }),
    });
    expect(csSetV2Item.statusCode).toBe(200);

    const csSetV2Submit = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV2Id)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-submit-${crypto.randomUUID()}` },
    });
    expect(csSetV2Submit.statusCode).toBe(200);

    const csSetV2Approve = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV2Id)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-approve-${crypto.randomUUID()}` },
    });
    expect(csSetV2Approve.statusCode).toBe(200);
    const csSetV2Approve2 = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV2Id)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-schema-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(csSetV2Approve2.statusCode).toBe(200);

    const csSetV2Release = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csSetV2Id)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-release-${crypto.randomUUID()}` },
    });
    expect(csSetV2Release.statusCode).toBe(200);

    const effectiveV2 = await ctx.app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(entityName)}/effective?schemaName=${encodeURIComponent(schemaName)}`,
      headers: { ...headers, "x-trace-id": `t-schema-effective-${crypto.randomUUID()}` },
    });
    expect(effectiveV2.statusCode).toBe(200);
    expect((effectiveV2.json() as any).fields?.b).toBeTruthy();

    const badWrite = await ctx.app.inject({
      method: "POST",
      url: `/entities/${encodeURIComponent(entityName)}`,
      headers: { ...headers, "x-trace-id": `t-schema-write-2-${crypto.randomUUID()}`, "idempotency-key": `idem-${crypto.randomUUID()}`, "x-schema-name": schemaName },
      payload: JSON.stringify({ a: "x" }),
    });
    expect(badWrite.statusCode).toBe(400);

    // 通过 changeset 回滚
    const csRollback = await ctx.app.inject({
      method: "POST",
      url: "/governance/changesets",
      headers: { ...headers, "x-trace-id": `t-schema-cs-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: `schema rollback ${schemaName}`, scope: "tenant" }),
    });
    expect(csRollback.statusCode).toBe(200);
    const csRollbackId = String((csRollback.json() as any).changeset.id);

    const csRollbackItem = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csRollbackId)}/items`,
      headers: { ...headers, "x-trace-id": `t-schema-cs-item-${crypto.randomUUID()}` },
      payload: JSON.stringify({ kind: "schema.rollback", name: schemaName }),
    });
    expect(csRollbackItem.statusCode).toBe(200);

    const csRollbackSubmit = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csRollbackId)}/submit`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-submit-${crypto.randomUUID()}` },
    });
    expect(csRollbackSubmit.statusCode).toBe(200);

    const csRollbackApprove = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csRollbackId)}/approve`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-approve-${crypto.randomUUID()}` },
    });
    expect(csRollbackApprove.statusCode).toBe(200);
    const csRollbackApprove2 = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csRollbackId)}/approve`,
      headers: { ...actionHeaders, authorization: "Bearer approver", "x-trace-id": `t-schema-cs-approve2-${crypto.randomUUID()}` },
    });
    expect(csRollbackApprove2.statusCode).toBe(200);

    const csRollbackRelease = await ctx.app.inject({
      method: "POST",
      url: `/governance/changesets/${encodeURIComponent(csRollbackId)}/release`,
      headers: { ...actionHeaders, "x-trace-id": `t-schema-cs-release-${crypto.randomUUID()}` },
    });
    expect(csRollbackRelease.statusCode).toBe(200);

    const latest2 = await ctx.app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(schemaName)}/latest`,
      headers: { ...headers, "x-trace-id": `t-schema-latest-${crypto.randomUUID()}` },
    });
    expect(latest2.statusCode).toBe(200);
    expect((latest2.json() as any).version).toBe(1);

    const effectiveRollback = await ctx.app.inject({
      method: "GET",
      url: `/schemas/${encodeURIComponent(entityName)}/effective?schemaName=${encodeURIComponent(schemaName)}`,
      headers: { ...headers, "x-trace-id": `t-schema-effective-${crypto.randomUUID()}` },
    });
    expect(effectiveRollback.statusCode).toBe(200);
    expect((effectiveRollback.json() as any).fields?.b).toBe(undefined);
  });

  it("locale：user preference 生效且可被 x-user-locale 覆盖", async () => {
    if (!ctx.canRun) return;
    const subjectId = `lang-${crypto.randomUUID()}`;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [subjectId, "tenant_dev"]);
    await pool.query(
      `
        INSERT INTO memory_user_preferences (tenant_id, subject_id, pref_key, pref_value, updated_at)
        VALUES ($1,$2,'locale',$3::jsonb,now())
        ON CONFLICT (tenant_id, subject_id, pref_key) DO UPDATE
        SET pref_value = EXCLUDED.pref_value, updated_at = now()
      `,
      ["tenant_dev", subjectId, JSON.stringify("en-US")],
    );
    const res1 = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${subjectId}`,
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": "t-locale-subject",
      },
    });
    expect(res1.statusCode).toBe(200);
    expect((res1.json() as any).locale).toBe("en-US");

    const res2 = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${subjectId}`,
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": "t-locale-override",
        "x-user-locale": "zh-CN",
      },
    });
    expect(res2.statusCode).toBe(200);
    expect((res2.json() as any).locale).toBe("zh-CN");
  });

  it("locale defaults：admin 可更新 tenant/space default_locale 并生效", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const t1 = await ctx.app.inject({
      method: "PUT",
      url: "/tenants/tenant_dev",
      headers: { ...h, "x-trace-id": `t-tenant-locale-${crypto.randomUUID()}` },
      payload: JSON.stringify({ settings: { default_locale: "en-US" } }),
    });
    if (t1.statusCode === 404) return;
    expect(t1.statusCode).toBe(200);

    const s1 = await ctx.app.inject({
      method: "PUT",
      url: "/spaces/space_dev",
      headers: { ...h, "x-trace-id": `t-space-locale-${crypto.randomUUID()}` },
      payload: JSON.stringify({ settings: { default_locale: "zh-CN" } }),
    });
    if (s1.statusCode === 404) return;
    expect(s1.statusCode).toBe(200);

    const fresh = `fresh-${crypto.randomUUID()}`;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [fresh, "tenant_dev"]);
    const me = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${fresh}`, "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": `t-me-${crypto.randomUUID()}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).locale).toBe("zh-CN");
  });
});
