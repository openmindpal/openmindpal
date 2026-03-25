import { Errors } from "../../../lib/errors";
import { decryptSecretPayload } from "../../../modules/secrets/envelope";
import { getSecretRecordEncryptedPayload } from "../../../modules/secrets/secretRepo";

export async function resolveChannelSecretPayload(params: { app: any; tenantId: string; spaceId: string | null; secretId: string }) {
  const secret = await getSecretRecordEncryptedPayload(params.app.db, params.tenantId, params.secretId);
  if (!secret) throw Errors.badRequest("Secret 不存在");
  if (secret.secret.status !== "active") throw Errors.badRequest("Secret 未激活");
  if (params.spaceId && (secret.secret.scopeType !== "space" || secret.secret.scopeId !== params.spaceId)) throw Errors.forbidden();

  try {
    const decrypted = await decryptSecretPayload({
      pool: params.app.db,
      tenantId: params.tenantId,
      masterKey: params.app.cfg.secrets.masterKey,
      scopeType: secret.secret.scopeType,
      scopeId: secret.secret.scopeId,
      keyVersion: secret.secret.keyVersion,
      encFormat: secret.secret.encFormat,
      encryptedPayload: secret.encryptedPayload,
    });
    return decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg === "key_disabled") throw Errors.keyDisabled();
    throw Errors.keyDecryptFailed();
  }
}

