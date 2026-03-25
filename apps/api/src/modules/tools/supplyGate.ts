function isTrustEnforcedNow() {
  const enforceRaw = String(process.env.SKILL_TRUST_ENFORCE ?? "").trim().toLowerCase();
  return process.env.NODE_ENV === "production" && !(enforceRaw === "0" || enforceRaw === "false" || enforceRaw === "no");
}

function dependencyScanMode() {
  const raw = String(process.env.SKILL_DEP_SCAN_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off" as const;
  if (raw === "audit_only") return "audit_only" as const;
  if (raw === "deny") return "deny" as const;
  return process.env.NODE_ENV === "production" ? ("deny" as const) : ("audit_only" as const);
}

function sbomMode() {
  const raw = String(process.env.SKILL_SBOM_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off" as const;
  if (raw === "audit_only") return "audit_only" as const;
  if (raw === "deny") return "deny" as const;
  return process.env.NODE_ENV === "production" ? ("deny" as const) : ("audit_only" as const);
}

export function toolTrustOk(trustSummary: any) {
  const required = isTrustEnforcedNow();
  const status = String(trustSummary?.status ?? "unknown").toLowerCase();
  if (status === "untrusted") return { ok: false, required, status };
  if (status === "trusted") return { ok: true, required, status };
  if (required) return { ok: false, required, status };
  return { ok: true, required, status };
}

export function toolScanOk(scanSummary: any) {
  const mode = dependencyScanMode();
  const required = mode === "deny";
  const status = String(scanSummary?.status ?? "").toLowerCase();
  const vulns = scanSummary?.vulnerabilities ?? null;
  const critical = Number(vulns?.critical ?? 0) || 0;
  const high = Number(vulns?.high ?? 0) || 0;
  if (!required) return { ok: true, required, mode, status, vulnerabilities: { critical, high } };
  if (status !== "ok") return { ok: false, required, mode, status: status || "missing", vulnerabilities: { critical, high } };
  if (critical > 0 || high > 0) return { ok: false, required, mode, status, vulnerabilities: { critical, high } };
  return { ok: true, required, mode, status, vulnerabilities: { critical, high } };
}

export function toolSbomOk(params: { sbomSummary: any; sbomDigest: any }) {
  const mode = sbomMode();
  const required = mode === "deny";
  const status = String(params.sbomSummary?.status ?? "").toLowerCase();
  const hasDigest = typeof params.sbomDigest === "string" && String(params.sbomDigest).length > 0;
  if (!required) return { ok: true, required, mode, status: status || "unknown", hasDigest };
  if (status === "ok" && hasDigest) return { ok: true, required, mode, status, hasDigest };
  return { ok: false, required, mode, status: status || "missing", hasDigest };
}
