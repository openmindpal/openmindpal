import { describe, expect, it } from "vitest";
import { compilePolicyExprWhere, validatePolicyExpr } from "@openslin/shared";

describe("policyExpr", () => {
  it("validatePolicyExpr: accepts basic eq expr", () => {
    const v = validatePolicyExpr({
      op: "eq",
      left: { kind: "record", key: "ownerSubjectId" },
      right: { kind: "subject", key: "subjectId" },
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.usedPayloadPaths).toEqual([]);
  });

  it("validatePolicyExpr: rejects unknown operator", () => {
    const v = validatePolicyExpr({ op: "gt", left: { kind: "subject", key: "subjectId" }, right: "x" });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errorCode).toBe("POLICY_EXPR_INVALID");
  });

  it("compilePolicyExprWhere: parameterizes payload path and values", () => {
    const args: any[] = [];
    const out = compilePolicyExprWhere({
      expr: { op: "eq", left: { kind: "payload", path: "a" }, right: "x" },
      subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
      args,
      idxStart: 0,
      ownerColumn: "owner_subject_id",
      payloadColumn: "payload",
    });
    expect(out.sql).toContain("#>>");
    expect(args.length).toBeGreaterThan(0);
    expect(JSON.stringify(args)).toContain("a");
  });

  it("compilePolicyExprWhere: rejects unsafe payload path", () => {
    const args: any[] = [];
    expect(() =>
      compilePolicyExprWhere({
        expr: { op: "exists", operand: { kind: "payload", path: "a);drop table x;--" } },
        subject: { subjectId: "u1", tenantId: "t1", spaceId: "s1" },
        args,
        idxStart: 0,
        ownerColumn: "owner_subject_id",
        payloadColumn: "payload",
      }),
    ).toThrow();
  });
});

