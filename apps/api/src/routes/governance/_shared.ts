import { Errors } from "../../lib/errors";
import { sha256Hex, stableStringify } from "../../lib/digest";
import { listUiComponentRegistryComponentIds } from "../../skills/ui-page-config/modules/componentRegistry";

export function resolveScope(subject: { tenantId: string; spaceId?: string | null }, scopeType: "tenant" | "space") {
  const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;
  if (!scopeId) throw Errors.badRequest("缺少 scopeId");
  return { scopeType, scopeId };
}

export function validateUiComponentRegistryComponentIds(componentIds: string[]) {
  const allowed = new Set(listUiComponentRegistryComponentIds());
  for (const id of componentIds) {
    if (!allowed.has(id)) throw Errors.uiComponentRegistryDenied(`非法 componentId：${id}`);
  }
}

export function evalReportDigest8FromCases(casesJson: any[]) {
  const cases = Array.isArray(casesJson) ? casesJson : [];
  const digestInput = cases.map((c: any) => ({
    caseId: c?.caseId ?? null,
    sourceType: c?.source?.type ?? null,
    toolRef: c?.toolRef ?? null,
    sealStatus: c?.sealStatus ?? null,
    sealedInputDigest: c?.sealedInputDigest ?? null,
    sealedOutputDigest: c?.sealedOutputDigest ?? null,
  }));
  return sha256Hex(stableStringify(digestInput)).slice(0, 8);
}

export function isHighRiskChangeSet(cs: any) {
  return cs?.riskLevel === "high" || Number(cs?.requiredApprovals ?? 0) >= 2;
}

