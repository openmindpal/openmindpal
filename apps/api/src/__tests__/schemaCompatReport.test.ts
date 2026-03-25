import { describe, expect, it } from "vitest";
import { computeSchemaCompatReportV1 } from "../modules/metadata/compat";

describe("schema compatReport v1", () => {
  it("compatible: 仅新增可选字段", () => {
    const prev: any = {
      name: "core",
      version: 1,
      entities: {
        notes: { fields: { title: { type: "string", required: true } } },
      },
    };
    const next: any = {
      name: "core",
      version: 2,
      entities: {
        notes: { fields: { title: { type: "string", required: true }, subtitle: { type: "string" } } },
      },
    };
    const r = computeSchemaCompatReportV1(prev, next);
    expect(r.level).toBe("compatible");
    expect(r.diffSummary.fields.added).toBe(1);
    expect(r.reasons).toEqual([]);
    expect(r.digest.sha256_8).toMatch(/^[a-f0-9]{8}$/);
  });

  it("migration_required: 新增必填字段/可选变必填", () => {
    const prev: any = {
      name: "core",
      version: 1,
      entities: {
        notes: { fields: { title: { type: "string" } } },
      },
    };
    const next: any = {
      name: "core",
      version: 2,
      entities: {
        notes: { fields: { title: { type: "string", required: true }, createdAt: { type: "datetime", required: true } } },
      },
    };
    const r = computeSchemaCompatReportV1(prev, next);
    expect(r.level).toBe("migration_required");
    expect(r.diffSummary.required.added).toBe(1);
    expect(r.diffSummary.required.upgraded).toBe(1);
    expect(r.reasons.map((x) => x.code).sort()).toEqual(["FIELD_REQUIRED_ADDED", "FIELD_REQUIRED_UPGRADED"].sort());
    expect(r.digest.sha256_8).toMatch(/^[a-f0-9]{8}$/);
  });

  it("breaking: 字段类型变更/实体删除/非法移除", () => {
    const prev: any = {
      name: "core",
      version: 3,
      entities: {
        notes: { fields: { title: { type: "string", required: true } } },
        tasks: { fields: { done: { type: "boolean" } } },
      },
    };
    const next: any = {
      name: "core",
      version: 4,
      entities: {
        notes: { fields: { title: { type: "number", required: true } } },
      },
    };
    const r = computeSchemaCompatReportV1(prev, next);
    expect(r.level).toBe("breaking");
    expect(r.reasons.some((x) => x.code === "ENTITY_REMOVED")).toBe(true);
    expect(r.reasons.some((x) => x.code === "FIELD_TYPE_CHANGED")).toBe(true);
    expect(r.digest.sha256_8).toMatch(/^[a-f0-9]{8}$/);
  });

  it("digest: key 顺序不影响 digest", () => {
    const prev1: any = {
      name: "core",
      version: 1,
      entities: {
        a: { fields: { x: { type: "string" }, y: { type: "number" } } },
        b: { fields: { z: { type: "boolean" } } },
      },
    };
    const next1: any = {
      name: "core",
      version: 2,
      entities: {
        a: { fields: { x: { type: "string", required: true }, y: { type: "number" } } },
        b: { fields: { z: { type: "boolean" } } },
      },
    };
    const prev2: any = {
      version: 1,
      name: "core",
      entities: {
        b: { fields: { z: { type: "boolean" } } },
        a: { fields: { y: { type: "number" }, x: { type: "string" } } },
      },
    };
    const next2: any = {
      version: 2,
      name: "core",
      entities: {
        b: { fields: { z: { type: "boolean" } } },
        a: { fields: { y: { type: "number" }, x: { required: true, type: "string" } } },
      },
    };
    const r1 = computeSchemaCompatReportV1(prev1, next1);
    const r2 = computeSchemaCompatReportV1(prev2, next2);
    expect(r1.digest.sha256_8).toBe(r2.digest.sha256_8);
    expect(r1.level).toBe(r2.level);
  });
});

