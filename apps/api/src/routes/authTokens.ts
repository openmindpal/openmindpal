import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { createAuthToken, getAuthTokenById, listAuthTokens, revokeAuthToken } from "../modules/auth/tokenRepo";
import { getSsoProvider, listSsoProviders } from "../modules/auth/ssoScimRepo";
import {
  buildSsoAuthorizeUrl,
  consumeSsoLoginState,
  createSsoLoginState,
  decodeJwtPayload,
  discoverOidcEndpoints,
  exchangeCodeForTokens,
  generateNonce,
  generateSsoState,
  mapClaims,
  validateIdTokenClaims,
} from "../modules/auth/ssoOidcRuntime";
import { ensureSubject } from "../modules/auth/subjectRepo";

export const authTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/tokens", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "token.create" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        expiresAt: z.string().min(1).max(100).optional(),
      })
      .parse(req.body);

    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const ms = Date.parse(body.expiresAt);
      if (!Number.isFinite(ms)) throw Errors.badRequest("expiresAt 不合法");
      if (ms <= Date.now()) throw Errors.badRequest("expiresAt 必须在未来");
      expiresAt = new Date(ms).toISOString();
    }

    const created = await createAuthToken({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId,
      name: body.name ?? null,
      expiresAt,
    });

    req.ctx.audit!.outputDigest = { tokenId: created.record.id, expiresAt };
    return {
      tokenId: created.record.id,
      token: created.token,
      expiresAt,
    };
  });

  app.get("/auth/tokens", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "token.read" });
    const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const limit = z.coerce.number().int().positive().max(200).optional().parse((req.query as any)?.limit) ?? 50;
    const items = await listAuthTokens({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId, limit });
    req.ctx.audit!.outputDigest = { count: items.length };
    return {
      items: items.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        spaceId: t.spaceId,
      })),
    };
  });

  /* ─── SSO/OIDC Login ─── §15.15 ─── */
  app.post("/auth/sso/initiate", async (req) => {
    setAuditContext(req, { resourceType: "auth", action: "sso.initiate" });
    const body = z.object({ tenantId: z.string().min(1), providerId: z.string().min(1).optional() }).parse(req.body);
    const tenantId = body.tenantId;
    const provider = body.providerId
      ? await getSsoProvider({ pool: app.db, tenantId, providerId: body.providerId })
      : (await listSsoProviders({ pool: app.db, tenantId })).find((p) => p.status === "active") ?? null;
    if (!provider) throw Errors.notFound("SSO provider");

    const discovery = await discoverOidcEndpoints(provider.issuerUrl);
    const state = generateSsoState();
    const nonce = generateNonce();
    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    const redirectUri = `${proto}://${host}/auth/sso/callback`;

    await createSsoLoginState({ pool: app.db, tenantId, providerId: provider.providerId, state, nonce, redirectUri });

    const authorizeUrl = buildSsoAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: provider.clientId,
      redirectUri,
      state,
      nonce,
      scopes: provider.scopes,
    });

    return { authorizeUrl, state, providerId: provider.providerId };
  });

  app.get("/auth/sso/callback", async (req) => {
    const qs = req.query as Record<string, string>;
    const code = String(qs.code ?? "").trim();
    const state = String(qs.state ?? "").trim();
    if (!code || !state) throw Errors.badRequest("缺少 code 或 state");

    setAuditContext(req, { resourceType: "auth", action: "sso.callback" });
    const loginState = await consumeSsoLoginState({ pool: app.db, state });
    if (!loginState) throw Errors.badRequest("SSO state 无效或已过期");

    const provider = await getSsoProvider({ pool: app.db, tenantId: loginState.tenantId, providerId: loginState.providerId });
    if (!provider || provider.status !== "active") throw Errors.badRequest("SSO provider 不可用");

    /* discover endpoints */
    const discovery = await discoverOidcEndpoints(provider.issuerUrl);

    /* exchange code for tokens */
    const clientSecret = provider.clientSecretRef ?? "";
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: discovery.token_endpoint,
      code,
      redirectUri: loginState.redirectUri,
      clientId: provider.clientId,
      clientSecret,
    });

    /* verify id_token */
    if (!tokens.id_token) throw Errors.badRequest("IdP 未返回 id_token");
    const claims = decodeJwtPayload(tokens.id_token);
    validateIdTokenClaims({ claims, issuer: discovery.issuer || provider.issuerUrl, clientId: provider.clientId });
    if (claims.nonce && claims.nonce !== loginState.nonce) throw Errors.badRequest("nonce 不匹配");

    /* map claims → subject */
    const mapped = mapClaims(claims, provider.claimMappings ?? {});
    if (!mapped.subjectId) throw Errors.badRequest("无法提取 subjectId");

    /* ensure subject exists (auto-provision) */
    await ensureSubject({ pool: app.db, tenantId: loginState.tenantId, subjectId: mapped.subjectId });

    /* issue auth token */
    const created = await createAuthToken({
      pool: app.db,
      tenantId: loginState.tenantId,
      spaceId: null,
      subjectId: mapped.subjectId,
      name: `sso:${provider.providerId}`,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    });

    return {
      token: created.token,
      tokenId: created.record.id,
      subjectId: mapped.subjectId,
      email: mapped.email,
      displayName: mapped.displayName,
      providerId: provider.providerId,
    };
  });

  app.post("/auth/tokens/:tokenId/revoke", async (req) => {
    const params = z.object({ tokenId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "auth", action: "token.revoke" });

    const subject = requireSubject(req);
    const token = await getAuthTokenById({ pool: app.db, tenantId: subject.tenantId, tokenId: params.tokenId });
    if (!token) throw Errors.notFound();

    if (token.subjectId === subject.subjectId) {
      const decision = await requirePermission({ req, resourceType: "auth", action: "token.self" });
      req.ctx.audit!.policyDecision = decision;
    } else {
      const decision = await requirePermission({ req, resourceType: "auth", action: "token.admin" });
      req.ctx.audit!.policyDecision = decision;
    }

    const revoked = await revokeAuthToken({ pool: app.db, tenantId: subject.tenantId, tokenId: token.id });
    req.ctx.audit!.outputDigest = { tokenId: token.id, revoked: Boolean(revoked) };
    return { ok: Boolean(revoked) };
  });
};

