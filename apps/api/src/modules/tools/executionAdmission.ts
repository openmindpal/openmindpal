import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { getEffectiveToolLimit } from "../governance/limitsRepo";
import { getEffectiveToolNetworkPolicy } from "../governance/toolNetworkPolicyRepo";
import { sha256Hex } from "../../lib/digest";

export function networkPolicyDigest(allowedDomains: string[], rules: any[] | null) {
  const canon = allowedDomains.map((d) => d.trim()).filter(Boolean).sort();
  const rulesCanon = Array.isArray(rules) ? rules : [];
  return {
    allowedDomainsCount: canon.length,
    sha256_8: sha256Hex(canon.join("\n")).slice(0, 8),
    rulesCount: rulesCanon.length,
    rulesSha256_8: sha256Hex(JSON.stringify(rulesCanon)).slice(0, 8),
  };
}

export type ExecutionAdmissionResult =
  | {
      ok: true;
      envelope: CapabilityEnvelopeV1;
      limits: any;
      networkPolicy: any;
      networkPolicyDigest: ReturnType<typeof networkPolicyDigest>;
      effectiveEnvelope: CapabilityEnvelopeV1;
    }
  | { ok: false; reason: "missing" | "invalid" | "not_subset"; details?: any };

export async function admitToolExecution(params: {
  pool: any;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  toolRef: string;
  toolContract: { scope: string; resourceType: string; action: string; fieldRules: any; rowFilters: any };
  limits?: any;
  requestedCapabilityEnvelope?: any;
  requireRequestedEnvelope: boolean;
}) : Promise<ExecutionAdmissionResult> {
  const isPlainObject = (v: any) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

  const effPol = await getEffectiveToolNetworkPolicy({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId ?? undefined, toolRef: params.toolRef });
  const effAllowedDomains = effPol?.allowedDomains ?? [];
  const effRules = (effPol as any)?.rules ?? [];
  const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };

  let limits = params.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) limits = {};
  if (limits.maxConcurrency === undefined) {
    const tl = await getEffectiveToolLimit({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: params.toolRef });
    if (tl) limits.maxConcurrency = tl.defaultMaxConcurrency;
  }
  const effLimits = normalizeRuntimeLimitsV1(limits);

  const effectiveEnvelope: CapabilityEnvelopeV1 = {
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      toolContract: {
        scope: params.toolContract.scope,
        resourceType: params.toolContract.resourceType,
        action: params.toolContract.action,
        fieldRules: params.toolContract.fieldRules ?? null,
        rowFilters: params.toolContract.rowFilters ?? null,
      },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
    resourceDomain: { limits: effLimits },
  };

  if (!params.requestedCapabilityEnvelope) {
    if (params.requireRequestedEnvelope) return { ok: false, reason: "missing" };
    const finalNetworkPolicy = effectiveEnvelope.egressDomain.networkPolicy;
    return {
      ok: true,
      envelope: effectiveEnvelope,
      limits: effectiveEnvelope.resourceDomain.limits,
      networkPolicy: finalNetworkPolicy,
      networkPolicyDigest: networkPolicyDigest(finalNetworkPolicy.allowedDomains, finalNetworkPolicy.rules ?? null),
      effectiveEnvelope,
    };
  }

  const parsed = validateCapabilityEnvelopeV1(params.requestedCapabilityEnvelope);
  if (!parsed.ok) return { ok: false, reason: "invalid" };

  const rawLimits = (params.requestedCapabilityEnvelope as any)?.resourceDomain?.limits;
  if (rawLimits === undefined || rawLimits === null || (isPlainObject(rawLimits) && Object.keys(rawLimits).length === 0)) {
    parsed.envelope.resourceDomain.limits = effectiveEnvelope.resourceDomain.limits;
  }

  const subset = checkCapabilityEnvelopeNotExceedV1({ envelope: parsed.envelope, effective: effectiveEnvelope });
  if (!subset.ok) return { ok: false, reason: "not_subset", details: { reason: subset.reason } };

  const finalEnvelope = parsed.envelope;
  const finalNetworkPolicy = finalEnvelope.egressDomain.networkPolicy;
  return {
    ok: true,
    envelope: finalEnvelope,
    limits: finalEnvelope.resourceDomain.limits,
    networkPolicy: finalNetworkPolicy,
    networkPolicyDigest: networkPolicyDigest(finalNetworkPolicy.allowedDomains, finalNetworkPolicy.rules ?? null),
    effectiveEnvelope,
  };
}
