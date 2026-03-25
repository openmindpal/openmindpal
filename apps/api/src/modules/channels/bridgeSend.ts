import crypto from "node:crypto";
import { Errors } from "../../lib/errors";
import { computeBridgeBodyDigest } from "./bridgeContract";

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hmacHex(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

export function signBridgeRequest(params: { secret: string; timestampMs: number; nonce: string; eventId: string; body: any }) {
  const bodyDigest = computeBridgeBodyDigest(params.body);
  const signingInput = `${params.timestampMs}.${params.nonce}.${params.eventId}.${bodyDigest}`;
  return hmacHex(params.secret, signingInput);
}

export async function bridgeSendWithRetry(params: {
  baseUrl: string;
  secret: string;
  provider: string;
  workspaceId: string;
  requestId: string;
  traceId: string;
  to: { channelChatId: string };
  message: { text: string };
  idempotencyKey: string;
  maxAttempts: number;
  backoffMsBase: number;
}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(params.maxAttempts || 1)));
  const backoffMsBase = Math.max(0, Math.min(2000, Number(params.backoffMsBase || 0)));

  const url = `${params.baseUrl.replace(/\/+$/, "")}/v1/send`;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const timestampMs = Date.now();
      const nonce = crypto.randomUUID();
      const eventId = params.idempotencyKey;
      const body = {
        provider: params.provider,
        workspaceId: params.workspaceId,
        requestId: params.requestId,
        traceId: params.traceId,
        to: params.to,
        message: params.message,
        idempotencyKey: params.idempotencyKey,
      };
      const signature = signBridgeRequest({ secret: params.secret, timestampMs, nonce, eventId, body });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bridge-timestamp": String(timestampMs),
          "x-bridge-nonce": nonce,
          "x-bridge-signature": signature,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          if (backoffMsBase) await sleep(backoffMsBase * attempt);
          continue;
        }
        throw Errors.badRequest("bridge_send_failed");
      }
      if (json && typeof json === "object") {
        const status = String((json as any).status ?? "");
        if (status === "error") {
          const code = String((json as any).errorCode ?? "");
          const retryable = code === "RETRYABLE";
          if (retryable && attempt < maxAttempts) {
            if (backoffMsBase) await sleep(backoffMsBase * attempt);
            continue;
          }
          throw Errors.badRequest("bridge_send_error");
        }
      }
      return json;
    } catch (e: any) {
      lastErr = e;
      if (attempt >= maxAttempts) throw lastErr;
      if (backoffMsBase) await sleep(backoffMsBase * attempt);
    }
  }
  throw lastErr ?? Errors.badRequest("bridge_send_failed");
}
