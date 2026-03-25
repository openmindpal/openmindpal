import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUDIT_ERROR_CATEGORIES, isHighRiskAuditAction, normalizeAuditErrorCategory } from "./auditRepo";

function canonicalize(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const out: any = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize(value[k]);
  return out;
}

function stableStringify(value: any) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

describe("audit hashchain", () => {
  it("hash 计算对 key 顺序稳定", () => {
    const a = computeEventHash({ prevHash: "p", normalized: { b: 1, a: { y: 2, x: 1 }, c: [2, 1] } });
    const b = computeEventHash({ prevHash: "p", normalized: { c: [2, 1], a: { x: 1, y: 2 }, b: 1 } });
    expect(a).toBe(b);
  });

  it("errorCategory 归一化稳定", () => {
    expect(AUDIT_ERROR_CATEGORIES).toEqual(["policy_violation", "validation_error", "rate_limited", "upstream_error", "internal_error"]);
    expect(normalizeAuditErrorCategory("internal")).toBe("internal_error");
    expect(normalizeAuditErrorCategory("upstream")).toBe("upstream_error");
    expect(normalizeAuditErrorCategory("invalid_input")).toBe("validation_error");
    expect(normalizeAuditErrorCategory("bad_request")).toBe("validation_error");
    expect(normalizeAuditErrorCategory("throttled")).toBe("rate_limited");
    expect(normalizeAuditErrorCategory("rate_limit")).toBe("rate_limited");
    expect(normalizeAuditErrorCategory("policy_violation")).toBe("policy_violation");
    expect(normalizeAuditErrorCategory("  POLICY_VIOLATION  ")).toBe("policy_violation");
    expect(normalizeAuditErrorCategory("")).toBe(null);
    expect(normalizeAuditErrorCategory("unexpected_value")).toBe("internal_error");
  });

  it("高风险动作判定稳定", () => {
    expect(isHighRiskAuditAction({ resourceType: "audit", action: "siem.destination.write" })).toBe(true);
    expect(isHighRiskAuditAction({ resourceType: "audit", action: "read" })).toBe(false);
  });
});
