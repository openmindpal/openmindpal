import { describe, expect, it } from "vitest";
import { compilePolicyExprWhere, validatePolicyExpr } from "@openslin/shared";

describe("policyExpr contract", () => {
  it("允许白名单 context 路径", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "context", path: "subject.id" },
      right: { kind: "record", key: "ownerSubjectId" },
    });
    expect(v.ok).toBe(true);
  });

  it("拒绝非白名单 context 路径", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "context", path: "subject.roleIds" },
      right: { kind: "literal", value: "x" },
    });
    expect(v.ok).toBe(false);
  });

  it("可编译包含 context 的 where", () => {
    const args: any[] = [];
    const out = compilePolicyExprWhere({
      expr: {
        op: "eq",
        left: { kind: "context", path: "subject.id" },
        right: { kind: "record", key: "ownerSubjectId" },
      },
      subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
      context: { request: { method: "GET", path: "/x", traceId: "t" }, resource: { type: "entity:note" } },
      args,
      idxStart: 0,
      ownerColumn: "owner_subject_id",
      payloadColumn: "payload",
    });
    expect(out.sql).toContain("owner_subject_id");
    expect(args.length).toBeGreaterThan(0);
  });
});

