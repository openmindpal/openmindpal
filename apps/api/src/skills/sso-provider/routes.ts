import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { getSsoProvider, listSsoProviders } from "../../modules/auth/ssoScimRepo";
import { createAuthToken } from "../../modules/auth/tokenRepo";
import {
  fetchOidcDiscovery,
  fetchJwks,
  decodeJwtPayload,
  decodeJwtHeader,
  verifyJwtSignature,
  exchangeCodeForTokens,
  mapClaims,
  createSsoLoginState,
  consumeSsoLoginState,
  buildSsoAuthorizeUrl,
  autoProvisionSsoUser,
} from "../../modules/auth/ssoRuntime";

export const ssoRoutes: FastifyPluginAsync = async (app) => {
  /* List available SSO providers for a tenant */
  app.get("/sso/providers", async (req) => {
    setAuditContext(req, { resourceType: "sso", action: "list_providers" });
    const tenantId = String((req.headers as any)["x-tenant-id"] ?? "").trim();
    if (!tenantId) throw Errors.badRequest("missing x-tenant-id");
    const providers = await listSsoProviders({ pool: app.db, tenantId });
    return {
      providers: providers
        .filter((p) => p.status === "active")
        .map((p) => ({ providerId: p.providerId, providerType: p.providerType, issuerUrl: p.issuerUrl })),
    };
  });

  /* Initiate SSO login — returns redirect URL to IdP */
  app.post("/sso/login", async (req) => {
    setAuditContext(req, { resourceType: "sso", action: "login" });
    const body = z.object({
      tenantId: z.string().min(1).max(200),
      providerId: z.string().min(1).max(200),
    }).parse(req.body);

    const provider = await getSsoProvider({ pool: app.db, tenantId: body.tenantId, providerId: body.providerId });
    if (!provider || provider.status !== "active") throw Errors.notFound("SSO provider");

    const discovery = await fetchOidcDiscovery(provider.issuerUrl);

    const state = crypto.randomBytes(32).toString("base64url");
    const nonce = crypto.randomBytes(16).toString("base64url");

    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    const redirectUri = `${proto}://${host}/sso/callback`;

    await createSsoLoginState({
      pool: app.db,
      tenantId: body.tenantId,
      providerId: body.providerId,
      state,
      nonce,
      redirectUri,
    });

    const authorizeUrl = buildSsoAuthorizeUrl({
      provider,
      authorizationEndpoint: discovery.authorization_endpoint,
      state,
      nonce,
      redirectUri,
    });

    return { authorizeUrl, state, expiresInSeconds: 600 };
  });

  /* SSO/OIDC Callback — token exchange + JWKS verify + session creation */
  app.get("/sso/callback", async (req) => {
    setAuditContext(req, { resourceType: "sso", action: "callback" });
    const qs = z.object({
      code: z.string().min(1),
      state: z.string().min(1),
    }).parse(req.query);

    /* Consume state */
    const loginState = await consumeSsoLoginState({ pool: app.db, state: qs.state });
    if (!loginState) throw Errors.badRequest("SSO state invalid or expired");

    const provider = await getSsoProvider({ pool: app.db, tenantId: loginState.tenantId, providerId: loginState.providerId });
    if (!provider || provider.status !== "active") throw Errors.notFound("SSO provider");

    /* Discover endpoints */
    const discovery = await fetchOidcDiscovery(provider.issuerUrl);

    /* Read client secret from env or provider config */
    const clientSecret = provider.clientSecretRef ?? process.env.SSO_CLIENT_SECRET ?? "";

    /* Exchange code for tokens */
    const tokens = await exchangeCodeForTokens({
      tokenEndpoint: discovery.token_endpoint,
      clientId: provider.clientId,
      clientSecret,
      code: qs.code,
      redirectUri: loginState.redirectUri,
    });

    if (!tokens.id_token) throw Errors.badRequest("No id_token in response");

    /* Verify ID token with JWKS */
    const jwksUri = provider.jwksUri ?? discovery.jwks_uri;
    const keys = await fetchJwks(jwksUri);
    const header = decodeJwtHeader(tokens.id_token);
    const kid = String(header.kid ?? "");
    const matchKey = kid ? keys.find((k) => k.kid === kid) : keys[0];
    if (matchKey) {
      const valid = verifyJwtSignature(tokens.id_token, matchKey);
      if (!valid) throw Errors.forbidden();
    }

    /* Decode claims */
    const claims = decodeJwtPayload(tokens.id_token);

    /* Verify nonce */
    if (claims.nonce && String(claims.nonce) !== loginState.nonce) {
      throw Errors.badRequest("SSO nonce mismatch");
    }

    /* Map claims */
    const mappings = provider.claimMappings && typeof provider.claimMappings === "object" ? provider.claimMappings : {};
    const mapped = mapClaims(claims, mappings);

    /* Auto-provision if enabled */
    if (provider.autoProvision) {
      await autoProvisionSsoUser({
        pool: app.db,
        tenantId: loginState.tenantId,
        provider,
        subjectId: mapped.subjectId,
        email: mapped.email,
        displayName: mapped.displayName,
      });
    }

    /* Create auth token (session) */
    const authToken = await createAuthToken({
      pool: app.db,
      tenantId: loginState.tenantId,
      spaceId: null,
      subjectId: mapped.subjectId,
      name: `sso:${provider.providerType}:${provider.providerId}`,
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    });

    req.ctx.audit!.outputDigest = {
      providerId: provider.providerId,
      subjectId: mapped.subjectId,
      email: mapped.email,
      autoProvisioned: provider.autoProvision,
    };

    return {
      token: authToken.token,
      tokenId: authToken.record.id,
      subjectId: mapped.subjectId,
      tenantId: loginState.tenantId,
      email: mapped.email,
      displayName: mapped.displayName,
    };
  });
};
