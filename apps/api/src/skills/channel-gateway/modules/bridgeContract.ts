import crypto from "node:crypto";
import { Errors } from "../../../lib/errors";
import { sha256Hex, stableStringify } from "./ingressDigest";

function hmacHex(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

export function computeBridgeBodyDigest(body: any) {
  return sha256Hex(stableStringify(body));
}

export function verifyBridgeSignature(params: {
  secret: string;
  timestampMs: number;
  nonce: string;
  eventId: string;
  bodyDigest: string;
  signature: string;
}) {
  const signingInput = `${params.timestampMs}.${params.nonce}.${params.eventId}.${params.bodyDigest}`;
  const expected = hmacHex(params.secret, signingInput);
  if (!params.signature || params.signature !== expected) throw Errors.channelSignatureInvalid();
}

