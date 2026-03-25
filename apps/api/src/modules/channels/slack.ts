import crypto from "node:crypto";
import { Errors } from "../../lib/errors";

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function timingSafeEqHex(aHex: string, bHex: string) {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifySlackSignature(params: { signingSecret: string; timestampSec: number; rawBody: string; signatureHeader: string }) {
  const hdr = String(params.signatureHeader ?? "");
  const ts = String(params.timestampSec ?? "");
  if (!hdr.startsWith("v0=")) throw Errors.channelSignatureInvalid();
  const sigHex = hdr.slice(3);
  if (!sigHex) throw Errors.channelSignatureInvalid();
  const base = `v0:${ts}:${params.rawBody}`;
  const expectedHex = crypto.createHmac("sha256", params.signingSecret).update(base, "utf8").digest("hex");
  if (!timingSafeEqHex(sigHex, expectedHex)) throw Errors.channelSignatureInvalid();
}

export async function slackSendTextWithRetry(params: {
  botToken: string;
  channel: string;
  text: string;
  maxAttempts: number;
  backoffMsBase: number;
}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(params.maxAttempts || 1)));
  const backoffMsBase = Math.max(0, Math.min(2000, Number(params.backoffMsBase || 0)));

  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${params.botToken}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: params.channel, text: params.text }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          if (backoffMsBase) await sleep(backoffMsBase * attempt);
          continue;
        }
        throw new Error(`slack_send_http_${res.status}`);
      }
      if (json && typeof json === "object" && (json as any).ok === false) {
        const err = String((json as any).error ?? "");
        const retryable = err === "ratelimited";
        if (retryable && attempt < maxAttempts) {
          if (backoffMsBase) await sleep(backoffMsBase * attempt);
          continue;
        }
        throw new Error(`slack_send_err_${err || "unknown"}`);
      }
      return json;
    } catch (e: any) {
      lastErr = e;
      if (attempt >= maxAttempts) throw lastErr;
      if (backoffMsBase) await sleep(backoffMsBase * attempt);
    }
  }
  throw lastErr ?? new Error("slack_send_failed");
}

