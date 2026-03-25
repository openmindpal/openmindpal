export const AUDIT_ERROR_CATEGORIES = [
  "policy_violation",
  "validation_error",
  "rate_limited",
  "upstream_error",
  "internal_error",
] as const;

export type AuditErrorCategory = (typeof AUDIT_ERROR_CATEGORIES)[number];

const AUDIT_ERROR_CATEGORY_SET = new Set<string>(AUDIT_ERROR_CATEGORIES);

export function normalizeAuditErrorCategory(input: unknown): AuditErrorCategory | null {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (AUDIT_ERROR_CATEGORY_SET.has(raw)) return raw as AuditErrorCategory;
  if (raw === "internal") return "internal_error";
  if (raw === "upstream") return "upstream_error";
  if (raw === "invalid_input" || raw === "bad_request") return "validation_error";
  if (raw === "throttled" || raw === "rate_limit") return "rate_limited";
  return "internal_error";
}
