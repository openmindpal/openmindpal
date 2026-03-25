import crypto from "node:crypto";
import { Errors } from "../../lib/errors";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function discordPublicKeyToKeyObject(publicKeyHex: string) {
  const raw = Buffer.from(String(publicKeyHex || ""), "hex");
  if (raw.length !== 32) throw Errors.badRequest("discordPublicKey 无效");
  const spkiDer = Buffer.concat([ed25519SpkiPrefix, raw]);
  return crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

export function verifyDiscordSignature(params: { publicKeyHex: string; signatureHex: string; timestamp: string; rawBody: string }) {
  const sig = Buffer.from(String(params.signatureHex || ""), "hex");
  const msg = Buffer.from(`${params.timestamp}${params.rawBody}`, "utf8");
  const key = discordPublicKeyToKeyObject(params.publicKeyHex);
  const ok = crypto.verify(null, msg, key, sig);
  if (!ok) throw Errors.channelSignatureInvalid();
}

