import type { FastifyRequest } from "fastify";
import { Errors } from "../../lib/errors";
import { authorize } from "./authz";
import type { AbacContext } from "./abacEngine";

export function requireSubject(req: FastifyRequest) {
  if (!req.ctx.subject) throw Errors.unauthorized(req.ctx.locale);
  return req.ctx.subject;
}

function buildAbacContext(req: FastifyRequest): AbacContext {
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.headers["x-real-ip"] as string | undefined ??
    req.ip ??
    undefined;
  const userAgent = req.headers["user-agent"] ?? undefined;
  const deviceType = detectDeviceType(userAgent);
  return {
    now: new Date(),
    clientIp,
    geoRegion: (req.headers["x-geo-region"] as string | undefined) ?? (req.headers["x-geo-country"] as string | undefined) ?? undefined,
    riskLevel: (req.headers["x-risk-level"] as string | undefined) ?? undefined,
    dataLabels: (req.headers["x-data-labels"] as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean) ?? undefined,
    deviceType,
    attributes: {},
  };
}

function detectDeviceType(ua?: string): string | undefined {
  if (!ua) return undefined;
  const lower = ua.toLowerCase();
  if (/mobile|android|iphone|ipod/.test(lower)) return "mobile";
  if (/tablet|ipad/.test(lower)) return "tablet";
  return "desktop";
}

export async function requirePermission(params: {
  req: FastifyRequest;
  resourceType: string;
  action: string;
}) {
  const subject = requireSubject(params.req);
  const abacCtx = buildAbacContext(params.req);
  const decision = await authorize({
    pool: params.req.server.db,
    subjectId: subject.subjectId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    resourceType: params.resourceType,
    action: params.action,
    abacCtx,
  });
  if (decision.decision !== "allow") {
    if (params.req.ctx.audit) params.req.ctx.audit.policyDecision = decision;
    throw Errors.forbidden();
  }
  return decision;
}
