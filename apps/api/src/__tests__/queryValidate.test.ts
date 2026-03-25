import { describe, expect, it } from "vitest";
import { validateEntityQuery } from "../modules/data/queryValidate";

describe("entity query validate", () => {
  it("拒绝不可读字段", () => {
    const schema: any = {
      name: "core",
      version: 1,
      entities: {
        notes: {
          fields: {
            title: { type: "string" },
            secret: { type: "string" },
          },
        },
      },
    };
    const decision: any = { fieldRules: { read: { allow: ["title"], deny: [] }, write: { allow: ["*"], deny: [] } } };
    expect(() =>
      validateEntityQuery({
        schema,
        entityName: "notes",
        decision,
        query: { filters: { field: "secret", op: "eq", value: "x" } } as any,
      }),
    ).toThrow();
  });
});

