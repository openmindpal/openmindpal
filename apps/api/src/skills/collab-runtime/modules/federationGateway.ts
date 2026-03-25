export type FederationGatewayStatus = {
  enabled: boolean;
  mode: "disabled" | "outbound_only" | "inbound_only" | "bi";
  provider: string | null;
};

export type FederationEnvelopeV1 = {
  format: "federation.envelope.v1";
  tenantId: string;
  collabRunId: string;
  correlationId: string;
  fromRole: string;
  toRole?: string | null;
  broadcast?: boolean;
  kind: "proposal" | "question" | "answer" | "observation" | "command";
  payloadDigest: any;
};

export function getFederationGatewayStatus(): FederationGatewayStatus {
  const raw = String(process.env.FEDERATION_MODE ?? "disabled").trim().toLowerCase();
  const mode = raw === "bi" || raw === "outbound_only" || raw === "inbound_only" ? (raw as any) : "disabled";
  const enabled = mode !== "disabled";
  const provider = enabled ? String(process.env.FEDERATION_PROVIDER ?? "").trim() || null : null;
  return { enabled, mode, provider };
}

export async function emitFederationEnvelope(_env: FederationEnvelopeV1): Promise<{ delivered: boolean; reason?: string }> {
  const st = getFederationGatewayStatus();
  if (!st.enabled) return { delivered: false, reason: "disabled" };
  return { delivered: false, reason: "not_implemented" };
}
