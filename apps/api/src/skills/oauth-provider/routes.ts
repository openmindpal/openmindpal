import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { ensureSubject } from "../../modules/auth/subjectRepo";
import { getConnectorInstance, getConnectorType } from "../connector-manager/modules/connectorRepo";
import { createSecretRecord, getSecretRecordEncryptedPayload, updateSecretRecordEncryptedPayload } from "../../modules/secrets/secretRepo";
import { decryptSecretPayload, encryptSecretEnvelope } from "../../modules/secrets/envelope";
import { createOAuthState, consumeOAuthState, getOAuthStateByState, newOAuthStateValue } from "./modules/oauthStateRepo";
import { getOAuthGrantByConnectorInstance, getOAuthGrantById, upsertOAuthGrant } from "./modules/oauthGrantRepo";
import { getOAuthProviderConfig } from "./modules/oauthProviderConfigRepo";

function tokenMetaDigest(token: any) {
  const access = typeof token?.access_token === "string" ? token.access_token : "";
  const refresh = typeof token?.refresh_token === "string" ? token.refresh_token : "";
  const expiresIn = typeof token?.expires_in === "number" ? token.expires_in : null;
  const scope = typeof token?.scope === "string" ? token.scope : "";
  return {
    hasAccessToken: Boolean(access),
    hasRefreshToken: Boolean(refresh),
    expiresIn,
    scopeLen: scope.length,
  };
}

function stateDigest(state: string) {
  const h = crypto.createHash("sha256").update(state, "utf8").digest("hex");
  return { sha256_8: h.slice(0, 8) };
}

function allowedDomainsFromPolicy(p: any): string[] {
  const ds = Array.isArray(p?.allowedDomains) ? p.allowedDomains : [];
  return ds
    .filter((x: any) => typeof x === "string" && x.trim())
    .map((x: string) => x.trim().toLowerCase())
    .filter((x: string) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"));
}

function assertDomainAllowed(allowed: string[], host: string) {
  if (!allowed.length) throw Errors.forbidden();
  const ok = allowed.includes(host.toLowerCase());
  if (!ok) throw Errors.forbidden();
}

const supportedProviders = ["mock", "wecom", "dingtalk", "feishu", "google"] as const;
type SupportedProvider = (typeof supportedProviders)[number];

function parseProvider(v: string): SupportedProvider {
  const p = String(v ?? "").trim().toLowerCase();
  if ((supportedProviders as readonly string[]).includes(p)) return p as SupportedProvider;
  throw Errors.badRequest("不支持的 provider");
}

function normalizeEndpoint(input: string) {
  let u: URL;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    throw Errors.badRequest("endpoint 非法");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw Errors.badRequest("endpoint 协议不支持");
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/g, "") || "/";
  const normalized = u.toString().replace(/\/+$/g, "");
  return { url: normalized, host: u.hostname.toLowerCase() };
}

function buildCallbackUrl(req: any, provider: string) {
  const xfProto = String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
  const host = String(req?.headers?.["x-forwarded-host"] ?? req?.headers?.host ?? "").split(",")[0]?.trim();
  if (!host) throw Errors.badRequest("缺少 host");
  return `${proto}://${host}/oauth/callback/${encodeURIComponent(provider)}`;
}

function sha256Base64Url(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("base64url");
}

async function readClientSecret(params: { app: any; tenantId: string; connectorInstanceId: string; secretId: string }) {
  const sec = await getSecretRecordEncryptedPayload(params.app.db, params.tenantId, params.secretId);
  if (!sec) throw Errors.badRequest("SecretRecord 不存在");
  if (sec.secret.status !== "active") throw Errors.badRequest("Secret 不可用");
  if (sec.secret.connectorInstanceId !== params.connectorInstanceId) throw Errors.badRequest("Secret 不属于该 ConnectorInstance");
  let payload: any;
  try {
    payload = await decryptSecretPayload({
      pool: params.app.db,
      tenantId: params.tenantId,
      masterKey: params.app.cfg.secrets.masterKey,
      scopeType: sec.secret.scopeType,
      scopeId: sec.secret.scopeId,
      keyVersion: sec.secret.keyVersion,
      encFormat: sec.secret.encFormat,
      encryptedPayload: sec.encryptedPayload,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (msg === "key_disabled") throw Errors.keyDisabled();
    throw Errors.keyDecryptFailed();
  }
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const clientSecret = typeof obj.clientSecret === "string" ? obj.clientSecret : typeof obj.secret === "string" ? obj.secret : "";
  if (!clientSecret) throw Errors.badRequest("Secret payload 缺少 clientSecret");
  return { clientSecret, scopeType: sec.secret.scopeType, scopeId: sec.secret.scopeId };
}

async function postFormJson(params: { url: string; body: Record<string, string>; headers?: Record<string, string> }) {
  const res = await fetch(params.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(params.headers ?? {}) },
    body: new URLSearchParams(params.body).toString(),
  } as any);
  const json = await (res as any).json?.();
  if (!(res as any).ok) {
    const err = json && typeof json === "object" ? json : {};
    throw Errors.badRequest(`OAuth 上游失败:${String((res as any).status ?? "")}:${String((err as any).error ?? "")}`);
  }
  return json;
}

function mockExchangeCodeForToken(code: string) {
  const id = crypto.randomUUID();
  return {
    access_token: `mock-access-${id}-${code}`,
    refresh_token: `mock-refresh-${id}`,
    expires_in: 3600,
    scope: "demo",
    token_type: "Bearer",
  };
}

function mockRefreshToken(refreshToken: string) {
  const id = crypto.randomUUID();
  return {
    access_token: `mock-access-${id}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: "demo",
    token_type: "Bearer",
  };
}

export const oauthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/oauth/providers", async (req) => {
    setAuditContext(req, { resourceType: "oauth", action: "read" });
    const decision = await requirePermission({ req, resourceType: "oauth", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    return {
      providers: [
        { key: "wecom", displayName: { "zh-CN": "企业微信", "en-US": "WeCom" }, pkceSupported: true },
        { key: "dingtalk", displayName: { "zh-CN": "钉钉", "en-US": "DingTalk" }, pkceSupported: true },
        { key: "feishu", displayName: { "zh-CN": "飞书", "en-US": "Feishu" }, pkceSupported: true },
        { key: "google", displayName: { "zh-CN": "Google", "en-US": "Google" }, pkceSupported: true },
      ],
    };
  });

  app.post("/oauth/authorize", async (req) => {
    setAuditContext(req, { resourceType: "oauth", action: "authorize" });
    const decision = await requirePermission({ req, resourceType: "oauth", action: "authorize" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z.object({ provider: z.string().min(1).max(50), connectorInstanceId: z.string().uuid() }).parse(req.body);
    const provider = parseProvider(body.provider);
    const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
    if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("ConnectorType 不存在");
    const allowed = allowedDomainsFromPolicy(inst.egressPolicy ?? type.defaultEgressPolicy);

    const redirectUri = buildCallbackUrl(req, provider);
    let pkce: { encFormat: string; keyVersion: number; encryptedPayload: any } | null = null;
    let pkceCodeVerifier: string | null = null;

    const state = newOAuthStateValue();
    const cfg = provider === "mock" ? null : await getOAuthProviderConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id, provider });
    if (provider !== "mock" && !cfg) throw Errors.badRequest("OAuth provider 未配置");
    if (cfg) {
      const ae = normalizeEndpoint(cfg.authorizeEndpoint);
      const te = normalizeEndpoint(cfg.tokenEndpoint);
      try {
        assertDomainAllowed(allowed, ae.host);
        assertDomainAllowed(allowed, te.host);
      } catch {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
      if (cfg.pkceEnabled) {
        const codeVerifier = crypto.randomBytes(32).toString("base64url");
        pkceCodeVerifier = codeVerifier;
        const enc = await encryptSecretEnvelope({
          pool: app.db,
          tenantId: subject.tenantId,
          scopeType: inst.scopeType,
          scopeId: inst.scopeId,
          masterKey: app.cfg.secrets.masterKey,
          payload: { codeVerifier },
        });
        pkce = { encFormat: enc.encFormat, keyVersion: enc.keyVersion, encryptedPayload: enc.encryptedPayload };
      }
    }
    const created = await createOAuthState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId,
      connectorInstanceId: inst.id,
      provider,
      state,
      pkceEncFormat: pkce?.encFormat ?? null,
      pkceKeyVersion: pkce?.keyVersion ?? null,
      pkceEncryptedPayload: pkce?.encryptedPayload ?? null,
      ttlSeconds: 600,
    });

    const authorizeUrl = (() => {
      if (provider === "mock") {
        return `https://mock.local/authorize?response_type=code&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      }
      if (!cfg) throw Errors.badRequest("OAuth provider 未配置");
      const u = new URL(cfg.authorizeEndpoint);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      if (cfg.scopes) u.searchParams.set("scope", cfg.scopes);
      const extra = cfg.extraAuthorizeParams && typeof cfg.extraAuthorizeParams === "object" ? (cfg.extraAuthorizeParams as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(extra)) {
        if (!k) continue;
        if (typeof v === "string") u.searchParams.set(k, v);
      }
      if (cfg.pkceEnabled) {
        if (!pkce || !pkceCodeVerifier) throw Errors.internal();
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("code_challenge", sha256Base64Url(pkceCodeVerifier));
      }
      return u.toString();
    })();

    req.ctx.audit!.inputDigest = { provider, connectorInstanceId: inst.id };
    req.ctx.audit!.outputDigest = { provider, connectorInstanceId: inst.id, expiresAt: created.expiresAt, state: stateDigest(state), pkce: { enabled: Boolean(cfg?.pkceEnabled) } };
    return { provider, connectorInstanceId: inst.id, authorizeUrl, expiresAt: created.expiresAt };
  });

  app.get("/oauth/callback/:provider", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const provider = parseProvider(params.provider);
    const q = z.object({ code: z.string().min(1), state: z.string().min(8) }).parse(req.query);
    setAuditContext(req, { resourceType: "oauth", action: "callback" });

    const authSubject = req.ctx.subject;
    const stateRow = await getOAuthStateByState({ pool: app.db, state: q.state });
    if (!stateRow) throw Errors.badRequest("OAuth state 无效");
    if (stateRow.provider !== provider) throw Errors.badRequest("OAuth provider 不匹配");
    const expMs =
      typeof stateRow.expiresAt === "string"
        ? Date.parse(stateRow.expiresAt.includes("T") ? stateRow.expiresAt : stateRow.expiresAt.replace(" ", "T"))
        : new Date(stateRow.expiresAt as any).getTime();
    if (!Number.isFinite(expMs) || expMs < Date.now()) throw Errors.badRequest("OAuth state 已过期");
    if (stateRow.consumedAt) throw Errors.badRequest("OAuth state 已使用");
    if (authSubject && (authSubject.subjectId !== stateRow.subjectId || authSubject.tenantId !== stateRow.tenantId || authSubject.spaceId !== (stateRow.spaceId ?? undefined))) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const consumed = await consumeOAuthState({ pool: app.db, state: q.state });
    if (!consumed) throw Errors.badRequest("OAuth state 无效或已使用");

    req.ctx.subject = { subjectId: consumed.subjectId, tenantId: consumed.tenantId, spaceId: consumed.spaceId ?? undefined };
    await ensureSubject({ pool: app.db, tenantId: consumed.tenantId, subjectId: consumed.subjectId });

    const inst = await getConnectorInstance(app.db, consumed.tenantId, consumed.connectorInstanceId);
    if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("ConnectorType 不存在");
    const allowed = allowedDomainsFromPolicy(inst.egressPolicy ?? type.defaultEgressPolicy);

    const redirectUri = buildCallbackUrl(req, provider);
    const tokenRes = await (async () => {
      if (provider === "mock") return { token: mockExchangeCodeForToken(q.code), endpointHost: "mock.local" };
      const cfg = await getOAuthProviderConfig({ pool: app.db, tenantId: consumed.tenantId, connectorInstanceId: inst.id, provider });
      if (!cfg) throw Errors.badRequest("OAuth provider 未配置");
      const te = normalizeEndpoint(cfg.tokenEndpoint);
      try {
        assertDomainAllowed(allowed, te.host);
      } catch {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
      const { clientSecret } = await readClientSecret({ app, tenantId: consumed.tenantId, connectorInstanceId: inst.id, secretId: cfg.clientSecretSecretId });
      let codeVerifier = "";
      if (cfg.pkceEnabled) {
        if (!consumed.pkceEncFormat || !consumed.pkceKeyVersion || !consumed.pkceEncryptedPayload) throw Errors.badRequest("OAuth PKCE 缺失");
        let pk: any;
        try {
          pk = await decryptSecretPayload({
            pool: app.db,
            tenantId: consumed.tenantId,
            masterKey: app.cfg.secrets.masterKey,
            scopeType: inst.scopeType,
            scopeId: inst.scopeId,
            keyVersion: consumed.pkceKeyVersion,
            encFormat: consumed.pkceEncFormat,
            encryptedPayload: consumed.pkceEncryptedPayload,
          });
        } catch (e: any) {
          const msg = String(e?.message ?? "");
          if (msg === "key_disabled") throw Errors.keyDisabled();
          throw Errors.keyDecryptFailed();
        }
        const obj = pk && typeof pk === "object" ? (pk as any) : {};
        codeVerifier = typeof obj.codeVerifier === "string" ? obj.codeVerifier : "";
        if (!codeVerifier) throw Errors.badRequest("OAuth PKCE 无效");
      }
      const extra = cfg.extraTokenParams && typeof cfg.extraTokenParams === "object" ? (cfg.extraTokenParams as Record<string, unknown>) : {};
      const form: Record<string, string> = {
        grant_type: "authorization_code",
        code: q.code,
        redirect_uri: redirectUri,
        client_id: cfg.clientId,
      };
      if (cfg.pkceEnabled) form.code_verifier = codeVerifier;
      if (cfg.tokenAuthMethod !== "client_secret_basic") form.client_secret = clientSecret;
      for (const [k, v] of Object.entries(extra)) if (k && typeof v === "string") form[k] = v;
      const headers: Record<string, string> = {};
      if (cfg.tokenAuthMethod === "client_secret_basic") {
        headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${clientSecret}`, "utf8").toString("base64")}`;
      }
      return { token: await postFormJson({ url: cfg.tokenEndpoint, body: form, headers }), endpointHost: te.host };
    })();
    const token = tokenRes.token;

    const existingGrant = await getOAuthGrantByConnectorInstance({ pool: app.db, tenantId: consumed.tenantId, connectorInstanceId: inst.id, provider });
    let secretId: string;
    if (existingGrant) {
      const existing = await getSecretRecordEncryptedPayload(app.db, consumed.tenantId, existingGrant.secretRecordId);
      if (!existing) throw Errors.badRequest("SecretRecord 不存在");
      const enc = await encryptSecretEnvelope({
        pool: app.db,
        tenantId: consumed.tenantId,
        scopeType: existing.secret.scopeType,
        scopeId: existing.secret.scopeId,
        masterKey: app.cfg.secrets.masterKey,
        payload: token,
      });
      const updated = await updateSecretRecordEncryptedPayload({
        pool: app.db,
        tenantId: consumed.tenantId,
        id: existingGrant.secretRecordId,
        encryptedPayload: enc.encryptedPayload,
        encFormat: enc.encFormat,
        keyVersion: enc.keyVersion,
        keyRef: enc.keyRef,
      });
      if (!updated) throw Errors.badRequest("SecretRecord 不存在");
      secretId = updated.id;
    } else {
      const enc = await encryptSecretEnvelope({
        pool: app.db,
        tenantId: consumed.tenantId,
        scopeType: inst.scopeType,
        scopeId: inst.scopeId,
        masterKey: app.cfg.secrets.masterKey,
        payload: token,
      });
      const secret = await createSecretRecord({
        pool: app.db,
        tenantId: consumed.tenantId,
        scopeType: inst.scopeType,
        scopeId: inst.scopeId,
        connectorInstanceId: inst.id,
        encryptedPayload: enc.encryptedPayload,
        keyVersion: enc.keyVersion,
        encFormat: enc.encFormat,
        keyRef: enc.keyRef,
      });
      secretId = secret.id;
    }

    const tokenExpiresAt =
      typeof (token as any).expires_in === "number" ? new Date(Date.now() + (token as any).expires_in * 1000).toISOString() : null;
    const grant = await upsertOAuthGrant({
      pool: app.db,
      tenantId: consumed.tenantId,
      spaceId: consumed.spaceId ?? null,
      connectorInstanceId: inst.id,
      provider,
      secretRecordId: secretId,
      scopes: typeof (token as any).scope === "string" ? (token as any).scope : null,
      tokenExpiresAt,
    });

    req.ctx.audit!.policyDecision = { effect: "allow", via: "state" };
    req.ctx.audit!.inputDigest = { provider, connectorInstanceId: inst.id, state: stateDigest(q.state) };
    req.ctx.audit!.outputDigest = { provider, grantId: grant.grantId, connectorInstanceId: inst.id, tokenMeta: tokenMetaDigest(token), endpointHost: tokenRes.endpointHost };
    return { provider, grantId: grant.grantId, connectorInstanceId: inst.id, status: grant.status };
  });

  app.post("/oauth/:provider/refresh", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const provider = parseProvider(params.provider);
    setAuditContext(req, { resourceType: "oauth", action: "refresh" });
    const decision = await requirePermission({ req, resourceType: "oauth", action: "refresh" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z.object({ grantId: z.string().uuid().optional(), connectorInstanceId: z.string().uuid().optional() }).parse(req.body);
    const grant = body.grantId
      ? await getOAuthGrantById({ pool: app.db, tenantId: subject.tenantId, grantId: body.grantId })
      : body.connectorInstanceId
        ? await getOAuthGrantByConnectorInstance({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: body.connectorInstanceId, provider })
        : null;
    if (!grant) throw Errors.badRequest("Grant 不存在");
    if (grant.spaceId && grant.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const inst = await getConnectorInstance(app.db, subject.tenantId, grant.connectorInstanceId);
    if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("ConnectorType 不存在");
    const allowed = allowedDomainsFromPolicy(inst.egressPolicy ?? type.defaultEgressPolicy);

    const sec = await getSecretRecordEncryptedPayload(app.db, subject.tenantId, grant.secretRecordId);
    if (!sec) throw Errors.badRequest("SecretRecord 不存在");
    let payload: any;
    try {
      payload = await decryptSecretPayload({
        pool: app.db,
        tenantId: subject.tenantId,
        masterKey: app.cfg.secrets.masterKey,
        scopeType: sec.secret.scopeType,
        scopeId: sec.secret.scopeId,
        keyVersion: sec.secret.keyVersion,
        encFormat: sec.secret.encFormat,
        encryptedPayload: sec.encryptedPayload,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg === "key_disabled") throw Errors.keyDisabled();
      throw Errors.keyDecryptFailed();
    }
    const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
    if (!refreshToken) throw Errors.badRequest("缺少 refresh_token");

    const token = await (async () => {
      if (provider === "mock") return mockRefreshToken(refreshToken);
      const cfg = await getOAuthProviderConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id, provider });
      if (!cfg) throw Errors.badRequest("OAuth provider 未配置");
      const re = normalizeEndpoint(cfg.refreshEndpoint ?? cfg.tokenEndpoint);
      try {
        assertDomainAllowed(allowed, re.host);
      } catch {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
      const { clientSecret } = await readClientSecret({ app, tenantId: subject.tenantId, connectorInstanceId: inst.id, secretId: cfg.clientSecretSecretId });
      const extra = cfg.extraTokenParams && typeof cfg.extraTokenParams === "object" ? (cfg.extraTokenParams as Record<string, unknown>) : {};
      const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId };
      if (cfg.tokenAuthMethod !== "client_secret_basic") form.client_secret = clientSecret;
      for (const [k, v] of Object.entries(extra)) if (k && typeof v === "string") form[k] = v;
      const headers: Record<string, string> = {};
      if (cfg.tokenAuthMethod === "client_secret_basic") {
        headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${clientSecret}`, "utf8").toString("base64")}`;
      }
      return await postFormJson({ url: cfg.refreshEndpoint ?? cfg.tokenEndpoint, body: form, headers });
    })();

    const enc = await encryptSecretEnvelope({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: sec.secret.scopeType,
      scopeId: sec.secret.scopeId,
      masterKey: app.cfg.secrets.masterKey,
      payload: token,
    });
    await updateSecretRecordEncryptedPayload({
      pool: app.db,
      tenantId: subject.tenantId,
      id: grant.secretRecordId,
      encryptedPayload: enc.encryptedPayload,
      encFormat: enc.encFormat,
      keyVersion: enc.keyVersion,
      keyRef: enc.keyRef,
    });
    const tokenExpiresAt =
      typeof (token as any).expires_in === "number" ? new Date(Date.now() + (token as any).expires_in * 1000).toISOString() : null;
    const updatedGrant = await upsertOAuthGrant({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      connectorInstanceId: inst.id,
      provider,
      secretRecordId: grant.secretRecordId,
      scopes: typeof (token as any).scope === "string" ? (token as any).scope : null,
      tokenExpiresAt,
    });

    req.ctx.audit!.inputDigest = { provider, grantId: updatedGrant.grantId, connectorInstanceId: updatedGrant.connectorInstanceId };
    req.ctx.audit!.outputDigest = { provider, grantId: updatedGrant.grantId, tokenMeta: tokenMetaDigest(token) };
    return { provider, grantId: updatedGrant.grantId, status: updatedGrant.status };
  });
};
