import type { Pool } from "pg";
import { decryptSecretPayload, encryptSecretEnvelopeWithKeyVersion } from "../../secrets/envelope";

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function mergeMetaInput(decrypted: any, metaInput: any) {
  if (!isPlainObject(decrypted) || !isPlainObject(metaInput)) return decrypted;
  const merged: any = { ...decrypted };
  const keys = ["planStepId", "actorRole", "stepKind", "dependsOn", "collabRunId", "taskId", "correlationId", "autoArbiter", "input"];
  for (const k of keys) {
    if (k in metaInput) merged[k] = (metaInput as any)[k];
  }
  return merged;
}

function isToolRefLike(v: unknown) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  const i = s.lastIndexOf("@");
  if (i <= 0 || i >= s.length - 1) return false;
  const ver = Number(s.slice(i + 1));
  return Number.isFinite(ver) && ver > 0;
}

function pickCompensationFromOutput(scrubbedOutput: any) {
  if (!isPlainObject(scrubbedOutput)) return null;
  const c = (scrubbedOutput as any).compensation;
  if (!isPlainObject(c)) return null;
  const toolRef = (c as any).compensatingToolRef;
  const input = (c as any).input;
  if (!isToolRefLike(toolRef) || !isPlainObject(input)) return null;
  const undoToken = (c as any).undoToken;
  const payload: any = { compensatingToolRef: String(toolRef), input };
  if (undoToken !== undefined) payload.undoToken = undoToken;
  return payload;
}

export async function decryptStepInputIfNeeded(params: { pool: Pool; tenantId: string; masterKey?: string; step: any; metaInput: any }) {
  const masterKey =
    String(params.masterKey ?? "").trim() ||
    String(process.env.API_MASTER_KEY ?? "").trim() ||
    (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  const encFormat = params.step?.input_enc_format as string | null;
  const encryptedPayload = params.step?.input_encrypted_payload as any;
  if (encFormat === "envelope.v1" && isPlainObject(encryptedPayload)) {
    const scopeType = String(encryptedPayload?.keyRef?.scopeType ?? "space");
    const scopeId = String(encryptedPayload?.keyRef?.scopeId ?? params.metaInput?.spaceId ?? params.metaInput?.space_id ?? "");
    const keyVersion = Number(encryptedPayload?.keyRef?.keyVersion ?? params.step?.input_key_version ?? 0);
    if (scopeId && Number.isFinite(keyVersion) && keyVersion > 0) {
      const dec = await decryptSecretPayload({
        pool: params.pool,
        tenantId: params.tenantId,
        masterKey,
        scopeType,
        scopeId,
        keyVersion,
        encFormat,
        encryptedPayload,
      });
      return mergeMetaInput(dec, params.metaInput);
    }
  }
  if (encFormat && encryptedPayload && (params.metaInput?.spaceId || params.metaInput?.space_id)) {
    const dec = await decryptSecretPayload({
      pool: params.pool,
      tenantId: params.tenantId,
      masterKey,
      scopeType: "space",
      scopeId: String(params.metaInput?.spaceId ?? params.metaInput?.space_id),
      keyVersion: Number(params.step?.input_key_version ?? 1),
      encFormat,
      encryptedPayload,
    });
    return mergeMetaInput(dec, params.metaInput);
  }
  return params.metaInput;
}

export async function encryptStepOutputAndCompensation(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  masterKey?: string;
  stepInputKeyVersion: number | null;
  jobType: string;
  toolName: string;
  schemaName: string;
  toolInput: any;
  scrubbedOutput: any;
  sideEffectWrite?: boolean;
}) {
  const masterKey =
    String(params.masterKey ?? "").trim() ||
    String(process.env.API_MASTER_KEY ?? "").trim() ||
    (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  let outputEncFormat: string | null = null;
  let outputKeyVersion: number | null = null;
  let outputEncryptedPayload: any | null = null;
  let compensationEncFormat: string | null = null;
  let compensationKeyVersion: number | null = null;
  let compensationEncryptedPayload: any | null = null;

  if (params.jobType !== "tool.execute" && params.jobType !== "agent.run") {
    return { outputEncFormat, outputKeyVersion, outputEncryptedPayload, compensationEncFormat, compensationKeyVersion, compensationEncryptedPayload };
  }

  const keyVersion = Number(params.stepInputKeyVersion ?? 1);
  try {
    outputEncryptedPayload = await encryptSecretEnvelopeWithKeyVersion({
      pool: params.pool,
      tenantId: params.tenantId,
      masterKey,
      scopeType: "space",
      scopeId: String(params.spaceId),
      keyVersion,
      payload: params.scrubbedOutput,
    });
    outputEncFormat = "envelope.v1";
    outputKeyVersion = keyVersion;
  } catch {}

  if (params.sideEffectWrite) {
    const fromOutput = pickCompensationFromOutput(params.scrubbedOutput);
    const fallback =
      params.toolName === "entity.create" && typeof params.scrubbedOutput?.recordId === "string"
        ? {
            undoToken: { kind: "entity.create", schemaName: params.schemaName, entityName: String(params.toolInput?.entityName ?? ""), recordId: params.scrubbedOutput.recordId },
            compensatingToolRef: "entity.delete@1",
            input: { schemaName: params.schemaName, entityName: String(params.toolInput?.entityName ?? ""), id: params.scrubbedOutput.recordId },
          }
        : null;
    const compensation = fromOutput ?? fallback;
    if (compensation) {
      try {
        compensationEncryptedPayload = await encryptSecretEnvelopeWithKeyVersion({
          pool: params.pool,
          tenantId: params.tenantId,
          masterKey,
          scopeType: "space",
          scopeId: String(params.spaceId),
          keyVersion,
          payload: compensation,
        });
        compensationEncFormat = "envelope.v1";
        compensationKeyVersion = keyVersion;
      } catch {}
    }
  }

  return { outputEncFormat, outputKeyVersion, outputEncryptedPayload, compensationEncFormat, compensationKeyVersion, compensationEncryptedPayload };
}
