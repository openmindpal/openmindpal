import { describe, expect, it } from "vitest";
import { checkSchemaCompatibility } from "../modules/metadata/compat";
import { validateSchemaExtensionNamespaces } from "../modules/metadata/schemaRepo";

describe("schema compat gate", () => {
  it("拒绝未标记 deprecated 的字段移除", () => {
    const prev: any = {
      name: "core",
      version: 3,
      entities: {
        notes: { fields: { title: { type: "string", required: true } } },
      },
    };
    const next: any = {
      name: "core",
      version: 4,
      entities: {
        notes: { fields: {} },
      },
    };
    const out = checkSchemaCompatibility(prev, next);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("FIELD_REMOVED_WITHOUT_DEPRECATION");
  });

  it("拒绝未到移除窗口的字段移除", () => {
    const prev: any = {
      name: "core",
      version: 3,
      entities: {
        notes: { fields: { title: { type: "string", deprecated: { removeAfterVersion: 6 } } } },
      },
    };
    const next: any = {
      name: "core",
      version: 4,
      entities: {
        notes: { fields: {} },
      },
    };
    const out = checkSchemaCompatibility(prev, next);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("FIELD_REMOVAL_WINDOW_NOT_REACHED");
  });

  it("允许到达移除窗口后的字段移除", () => {
    const prev: any = {
      name: "core",
      version: 5,
      entities: {
        notes: { fields: { title: { type: "string", deprecated: { removeAfterVersion: 6 } } } },
      },
    };
    const next: any = {
      name: "core",
      version: 6,
      entities: {
        notes: { fields: {} },
      },
    };
    expect(checkSchemaCompatibility(prev, next)).toEqual({ ok: true });
  });
});

describe("schema extension namespace gate", () => {
  it("拒绝非法命名空间格式", () => {
    const out = validateSchemaExtensionNamespaces({
      name: "core",
      entities: {},
      extensions: {
        "BadNamespace": {},
      },
    });
    expect(out.ok).toBe(false);
  });

  it("允许受支持命名空间", () => {
    const out = validateSchemaExtensionNamespaces({
      name: "core",
      entities: {
        notes: {
          fields: {
            title: {
              type: "string",
              extensions: {
                "io.openslin.editor": { widget: "text" },
              },
            },
          },
        },
      },
      extensions: {
        "org.openslin.schema": { tier: "stable" },
      },
    });
    expect(out).toEqual({ ok: true });
  });
});
