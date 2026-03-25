import crypto from "node:crypto";
import type { Pool } from "pg";
import { getAuthTokenByHash, sha256Hex, touchAuthTokenLastUsed } from "./tokenRepo";

export type Subject = {
  subjectId: string;
  tenantId: string;
  spaceId?: string;
};

function base64UrlDecodeToBuffer(s: string) {
  return Buffer.from(s, "base64url");
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseDevToken(token: string) {
  const t = token.trim();
  const at = t.indexOf("@");
  if (at > 0) {
    const subjectId = t.slice(0, at);
    const spaceId = t.slice(at + 1) || undefined;
    return { subjectId, spaceId };
  }
  return { subjectId: t, spaceId: undefined };
}

function parseAuthorizationValue(authorization?: string) {
  const auth = authorization ?? "";
  if (!auth.trim()) return null;
  if (auth.toLowerCase().startsWith("device ")) return null;
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : auth;
  if (!token || !token.trim()) return null;
  return token.trim();
}

function authenticateDev(token: string): Subject | null {
  const parsed = parseDevToken(token);
  const tenantId = "tenant_dev";
  const spaceId = parsed.spaceId ?? "space_dev";
  if (!parsed.subjectId) return null;
  return { subjectId: parsed.subjectId, tenantId, spaceId };
}

function authenticateHmac(token: string): Subject | null {
  const secret = process.env.AUTHN_HMAC_SECRET ?? "";
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payloadPart = parts[0];
  const sigPart = parts[1];
  if (!payloadPart || !sigPart) return null;
  if (payloadPart.length > 2048 || sigPart.length > 256) return null;

  const expected = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
  let provided: Buffer;
  try {
    provided = base64UrlDecodeToBuffer(sigPart);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  const payloadBuf = base64UrlDecodeToBuffer(payloadPart);
  if (payloadBuf.length > 4096) return null;
  const payload = safeJsonParse(payloadBuf.toString("utf8"));
  if (!payload || typeof payload !== "object") return null;

  const tenantId = typeof (payload as any).tenantId === "string" ? (payload as any).tenantId : "";
  const subjectId = typeof (payload as any).subjectId === "string" ? (payload as any).subjectId : "";
  const spaceId = typeof (payload as any).spaceId === "string" ? (payload as any).spaceId : undefined;
  const exp = typeof (payload as any).exp === "number" ? (payload as any).exp : NaN;
  if (!tenantId || !subjectId || !Number.isFinite(exp)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) return null;
  return { subjectId, tenantId, spaceId };
}

export async function authenticate(params: { pool?: Pool; authorization?: string }): Promise<Subject | null> {
  const auth = params.authorization;
  const token = parseAuthorizationValue(auth);
  if (!token) return null;

  const mode = process.env.AUTHN_MODE === "pat" ? "pat" : process.env.AUTHN_MODE === "hmac" ? "hmac" : "dev";

  if (mode === "pat") {
    if (token.startsWith("pat_")) {
      if (!params.pool) return null;
      const rec = await getAuthTokenByHash({ pool: params.pool, tokenHash: sha256Hex(token) });
      if (!rec) return null;
      if (rec.revokedAt) return null;
      if (rec.expiresAt) {
        const exp = Date.parse(rec.expiresAt);
        if (Number.isFinite(exp) && exp <= Date.now()) return null;
      }
      await touchAuthTokenLastUsed({ pool: params.pool, tokenId: rec.id });
      return { subjectId: rec.subjectId, tenantId: rec.tenantId, spaceId: rec.spaceId ?? undefined };
    }

    const compat = String(process.env.AUTHN_PAT_COMPAT_MODE ?? "").trim();
    if (compat === "hmac") return authenticateHmac(token);
    if (compat === "dev") return authenticateDev(token);
    return null;
  }

  if (mode === "hmac") return authenticateHmac(token);
  return authenticateDev(token);
}
