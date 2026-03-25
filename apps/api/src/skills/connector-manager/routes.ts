import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../../modules/audit/requestOutbox";
import { createConnectorInstance, getConnectorInstance, getConnectorType, listConnectorInstances, listConnectorTypes, setConnectorInstanceStatus } from "./modules/connectorRepo";
import { getExchangeConnectorConfig, upsertExchangeConnectorConfig } from "./modules/exchangeRepo";
import { getImapConnectorConfig, upsertImapConnectorConfig } from "./modules/imapRepo";
import { getSmtpConnectorConfig, upsertSmtpConnectorConfig } from "./modules/smtpRepo";
import { getOAuthGrantById } from "../oauth-provider/modules/oauthGrantRepo";
import { getOAuthProviderConfig, upsertOAuthProviderConfig } from "../oauth-provider/modules/oauthProviderConfigRepo";
import { getSecretRecord } from "../../modules/secrets/secretRepo";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

function normalizeEndpoint(input: string) {
  let u: URL;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    throw Errors.badRequest("endpoint 非法");
  }
  if (u.protocol !== "https:") throw Errors.badRequest("endpoint 仅支持 https");
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/g, "") || "/";
  const normalized = u.toString().replace(/\/+$/g, "");
  return { url: normalized, host: u.hostname.toLowerCase() };
}

function normalizeAllowedDomains(v: any) {
  const arr = Array.isArray(v) ? v : [];
  const out = arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"));
  return Array.from(new Set(out));
}

export const connectorRoutes: FastifyPluginAsync = async (app) => {
  app.get("/connectors/types", async (req) => {
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const types = await listConnectorTypes(app.db);
    return { types };
  });

  app.get("/connectors/instances", async (req) => {
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const instances = await listConnectorInstances(app.db, subject.tenantId, scope.scopeType, scope.scopeId);
    return { scope, instances };
  });

  app.post("/connectors/instances", async (req) => {
    setAuditContext(req, { resourceType: "connector", action: "create", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        name: z.string().min(1),
        typeName: z.string().min(1),
        egressPolicy: z
          .object({
            allowedDomains: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const type = await getConnectorType(app.db, body.typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");

    const normalizedPolicy = body.egressPolicy
      ? {
          allowedDomains: normalizeAllowedDomains(body.egressPolicy.allowedDomains ?? []),
        }
      : null;

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const instance = await createConnectorInstance({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        name: body.name,
        typeName: body.typeName,
        egressPolicy: normalizedPolicy,
      });
      req.ctx.audit!.outputDigest = { connectorInstanceId: instance.id, typeName: instance.typeName, scopeType: instance.scopeType };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { scope, instance };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.post("/connectors/instances/:id/disable", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "disable", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "disable" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const inst = await setConnectorInstanceStatus(client, subject.tenantId, params.id, "disabled");
      if (!inst) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
      }
      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, status: inst.status };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { instance: inst };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.post("/connectors/instances/:id/enable", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "enable", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "enable" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const inst = await setConnectorInstanceStatus(client, subject.tenantId, params.id, "enabled");
      if (!inst) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
      }
      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, status: inst.status };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { instance: inst };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/connectors/instances/:id", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    return { instance: inst };
  });

  app.get("/connectors/instances/:id/oauth/:provider", async (req, reply) => {
    const params = z.object({ id: z.string().min(3), provider: z.enum(["wecom", "dingtalk", "feishu", "google"]) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    const cfg = await getOAuthProviderConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id, provider: params.provider });
    return { config: cfg };
  });

  app.post("/connectors/instances/:id/oauth/:provider", async (req, reply) => {
    const params = z.object({ id: z.string().min(3), provider: z.enum(["wecom", "dingtalk", "feishu", "google"]) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");
    const allowed = normalizeAllowedDomains(inst.egressPolicy?.allowedDomains ?? type.defaultEgressPolicy?.allowedDomains ?? []);

    const body = z
      .object({
        authorizeEndpoint: z.string().min(8),
        tokenEndpoint: z.string().min(8),
        refreshEndpoint: z.string().min(8).optional(),
        userinfoEndpoint: z.string().min(8).optional(),
        clientId: z.string().min(1).max(300),
        clientSecretSecretId: z.string().uuid(),
        scopes: z.string().min(1).max(2000).optional(),
        pkceEnabled: z.boolean().optional(),
        tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
        extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
        extraTokenParams: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);

    const auth = normalizeEndpoint(body.authorizeEndpoint);
    const token = normalizeEndpoint(body.tokenEndpoint);
    const refresh = body.refreshEndpoint ? normalizeEndpoint(body.refreshEndpoint) : null;
    const userinfo = body.userinfoEndpoint ? normalizeEndpoint(body.userinfoEndpoint) : null;
    const hosts = [auth.host, token.host, refresh?.host ?? null, userinfo?.host ?? null].filter(Boolean) as string[];
    const notAllowed = hosts.filter((h) => !allowed.includes(h));
    if (notAllowed.length) throw Errors.badRequest("egressPolicy.allowedDomains 未包含 OAuth endpoint host");

    const secret = await getSecretRecord(app.db, subject.tenantId, body.clientSecretSecretId);
    if (!secret) throw Errors.badRequest("Secret 不存在");
    if (secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 不属于该 ConnectorInstance");
    if (secret.status !== "active") throw Errors.badRequest("Secret 不可用");

    const pkceEnabled = body.pkceEnabled ?? true;
    const tokenAuthMethod = body.tokenAuthMethod ?? "client_secret_post";

    req.ctx.audit!.outputDigest = {
      connectorInstanceId: inst.id,
      provider: params.provider,
      endpointHosts: Array.from(new Set(hosts)).sort(),
      scopesLen: (body.scopes ?? "").length,
      pkceEnabled,
      tokenAuthMethod,
    };
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const saved = await upsertOAuthProviderConfig({
        pool: client,
        tenantId: subject.tenantId,
        connectorInstanceId: inst.id,
        provider: params.provider,
        authorizeEndpoint: auth.url,
        tokenEndpoint: token.url,
        refreshEndpoint: refresh?.url ?? null,
        userinfoEndpoint: userinfo?.url ?? null,
        clientId: body.clientId,
        clientSecretSecretId: body.clientSecretSecretId,
        scopes: body.scopes ?? null,
        pkceEnabled,
        tokenAuthMethod,
        extraAuthorizeParams: body.extraAuthorizeParams ?? {},
        extraTokenParams: body.extraTokenParams ?? {},
      });
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { config: saved };
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/connectors/instances/:id/imap", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    const cfg = await getImapConnectorConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id });
    return { config: cfg };
  });

  app.post("/connectors/instances/:id/imap", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    if (inst.typeName !== "mail.imap") throw Errors.badRequest("连接器类型不支持 IMAP 配置");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");

    const body = z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        useTls: z.boolean(),
        username: z.string().min(1).max(200),
        passwordSecretId: z.string().uuid(),
        mailbox: z.string().min(1).max(200),
        fetchWindowDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);

    const host = body.host.trim().toLowerCase();
    if (host.includes("://") || host.includes("/") || host.includes(":")) throw Errors.badRequest("host 必须为纯域名");

    const allowed = normalizeAllowedDomains(inst.egressPolicy?.allowedDomains ?? type.defaultEgressPolicy?.allowedDomains ?? []);
    if (!allowed.includes(host)) throw Errors.badRequest("egressPolicy.allowedDomains 未包含 IMAP host");

    const secret = await getSecretRecord(app.db, subject.tenantId, body.passwordSecretId);
    if (!secret) throw Errors.badRequest("Secret 不存在");
    if (secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 不属于该 ConnectorInstance");
    if (secret.status !== "active") throw Errors.badRequest("Secret 不可用");

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const cfg = await upsertImapConnectorConfig({
        pool: client,
        connectorInstanceId: inst.id,
        tenantId: subject.tenantId,
        host,
        port: body.port,
        useTls: body.useTls,
        username: body.username,
        passwordSecretId: body.passwordSecretId,
        mailbox: body.mailbox,
        fetchWindowDays: body.fetchWindowDays ?? null,
      });
      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, host: cfg.host, mailbox: cfg.mailbox, port: cfg.port, useTls: cfg.useTls };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { config: cfg };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/connectors/instances/:id/exchange", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    const cfg = await getExchangeConnectorConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id });
    return { config: cfg };
  });

  app.post("/connectors/instances/:id/exchange", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    if (inst.typeName !== "mail.exchange") throw Errors.badRequest("连接器类型不支持 Exchange 配置");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");

    const body = z
      .object({
        oauthGrantId: z.string().uuid(),
        mailbox: z.string().min(1).max(320),
        fetchWindowDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);

    const host = "graph.microsoft.com";
    const allowed = normalizeAllowedDomains(inst.egressPolicy?.allowedDomains ?? type.defaultEgressPolicy?.allowedDomains ?? []);
    if (!allowed.includes(host)) throw Errors.badRequest("egressPolicy.allowedDomains 未包含 graph.microsoft.com");

    const grant = await getOAuthGrantById({ pool: app.db, tenantId: subject.tenantId, grantId: body.oauthGrantId });
    if (!grant) throw Errors.badRequest("OAuthGrant 不存在");
    if ((grant.spaceId ?? null) !== (inst.scopeType === "space" ? inst.scopeId : null)) throw Errors.forbidden();
    if (grant.status !== "active") throw Errors.badRequest("OAuthGrant 不可用");

    const secret = await getSecretRecord(app.db, subject.tenantId, grant.secretRecordId);
    if (!secret) throw Errors.badRequest("Secret 不存在");
    if (secret.connectorInstanceId !== grant.connectorInstanceId) throw Errors.badRequest("OAuthGrant Secret 不属于其 ConnectorInstance");
    if (secret.status !== "active") throw Errors.badRequest("Secret 不可用");

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const cfg = await upsertExchangeConnectorConfig({
        pool: client,
        connectorInstanceId: inst.id,
        tenantId: subject.tenantId,
        oauthGrantId: body.oauthGrantId,
        mailbox: body.mailbox,
        fetchWindowDays: body.fetchWindowDays ?? null,
      });
      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, mailbox: cfg.mailbox, host };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { config: cfg };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });

  app.get("/connectors/instances/:id/smtp", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "read" });
    const decision = await requirePermission({ req, resourceType: "connector", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    const cfg = await getSmtpConnectorConfig({ pool: app.db, tenantId: subject.tenantId, connectorInstanceId: inst.id });
    return { config: cfg };
  });

  app.post("/connectors/instances/:id/smtp", async (req, reply) => {
    const params = z.object({ id: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "connector", action: "update", requireOutbox: true });
    const decision = await requirePermission({ req, resourceType: "connector", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const inst = await getConnectorInstance(app.db, subject.tenantId, params.id);
    if (!inst) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "ConnectorInstance 不存在", "en-US": "ConnectorInstance not found" }, traceId: req.ctx.traceId });
    if (inst.typeName !== "mail.smtp") throw Errors.badRequest("连接器类型不支持 SMTP 配置");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");

    const type = await getConnectorType(app.db, inst.typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");

    const body = z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        useTls: z.boolean(),
        username: z.string().min(1).max(200),
        passwordSecretId: z.string().uuid(),
        fromAddress: z.string().min(3).max(320),
      })
      .parse(req.body);

    const host = body.host.trim().toLowerCase();
    if (host.includes("://") || host.includes("/") || host.includes(":")) throw Errors.badRequest("host 必须为纯域名");

    const allowed = normalizeAllowedDomains(inst.egressPolicy?.allowedDomains ?? type.defaultEgressPolicy?.allowedDomains ?? []);
    if (!allowed.includes(host)) throw Errors.badRequest("egressPolicy.allowedDomains 未包含 SMTP host");

    const secret = await getSecretRecord(app.db, subject.tenantId, body.passwordSecretId);
    if (!secret) throw Errors.badRequest("Secret 不存在");
    if (secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 不属于该 ConnectorInstance");
    if (secret.status !== "active") throw Errors.badRequest("Secret 不可用");

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      const cfg = await upsertSmtpConnectorConfig({
        pool: client,
        connectorInstanceId: inst.id,
        tenantId: subject.tenantId,
        host,
        port: body.port,
        useTls: body.useTls,
        username: body.username,
        passwordSecretId: body.passwordSecretId,
        fromAddress: body.fromAddress,
      });
      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, host: cfg.host, port: cfg.port, useTls: cfg.useTls };
      await enqueueAuditOutboxForRequest({ client, req });
      await client.query("COMMIT");
      return { config: cfg };
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw Errors.auditOutboxWriteFailed();
    } finally {
      client.release();
    }
  });
};
