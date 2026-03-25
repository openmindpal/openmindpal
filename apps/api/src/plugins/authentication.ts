import type { FastifyPluginAsync } from "fastify";
import { Errors } from "../lib/errors";
import { getDeviceByTokenHash } from "../lib/deviceAuth";
import { sha256Hex } from "../lib/digest";
import { authenticate } from "../modules/auth/authn";
import { ensureSubject } from "../modules/auth/subjectRepo";

function readCookieValue(cookieHeader: unknown, name: string) {
  const raw = typeof cookieHeader === "string" ? cookieHeader : "";
  if (!raw) return "";
  const parts = raw.split(";").map((x) => x.trim());
  const key = `${encodeURIComponent(name)}=`;
  for (const p of parts) {
    if (!p.startsWith(key)) continue;
    const v = p.slice(key.length);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

export const authenticationPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    const headerAuth = req.headers.authorization;
    const cookieToken = readCookieValue(req.headers.cookie, "openslin_token").trim();
    const cookieAuth =
      cookieToken && !headerAuth
        ? cookieToken.toLowerCase().startsWith("bearer ") || cookieToken.toLowerCase().startsWith("device ")
          ? cookieToken
          : `Bearer ${cookieToken}`
        : undefined;
    const subject = await authenticate({ pool: app.db, authorization: headerAuth ?? cookieAuth });
    if (!subject) return;
    req.ctx.subject = subject;
  });

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/device-agent")) return;
    const auth = req.headers.authorization ?? "";
    const token = auth.toLowerCase().startsWith("device ") ? auth.slice("device ".length).trim() : "";
    if (!token) return;
    const device = await getDeviceByTokenHash({ pool: app.db, deviceTokenHash: sha256Hex(token) });
    if (!device) return;
    (req.ctx as any).device = device;
  });

  app.addHook("onRequest", async (req) => {
    const subject = req.ctx.subject;
    if (!subject) return;
    const ensured = await ensureSubject({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });
    if (!ensured.ok) throw Errors.unauthorized(req.ctx.locale);
  });
};
