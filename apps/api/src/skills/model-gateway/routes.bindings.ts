import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { decryptSecretPayload } from "../../modules/secrets/envelope";
import { getSecretRecord, getSecretRecordEncryptedPayload } from "../../modules/secrets/secretRepo";
import { getConnectorInstance } from "../connector-manager/modules/connectorRepo";
import { createBinding, deleteBinding, getBindingById, listBindings } from "./modules/bindingRepo";
import { findCatalogByRef } from "./modules/catalog";
import { openAiChatWithSecretRotation } from "./modules/openaiChat";
import {
  getHostFromBaseUrl,
  isOpenAiCompatibleProvider,
  normalizeBaseUrl,
  normalizeChatCompletionsPath,
  normalizeOpenAiCompatibleBaseUrl,
  parseProviderModelRef,
  resolveScope,
} from "./modules/helpers";

export const modelBindingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/models/bindings", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    const decision = await requirePermission({ req, resourceType: "model", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const bindings = await listBindings(app.db, subject.tenantId, scope.scopeType, scope.scopeId);
    return { scope, bindings };
  });

  app.post("/models/bindings", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "bind" });
    const decision = await requirePermission({ req, resourceType: "model", action: "bind" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        modelRef: z.string().min(3),
        connectorInstanceId: z.string().uuid(),
        secretId: z.string().uuid().optional(),
        secretIds: z.array(z.string().uuid()).max(10).optional(),
        baseUrl: z.string().min(1).optional(),
        chatCompletionsPath: z.string().max(200).optional(),
        testBeforeSave: z.boolean().optional(),
      })
      .parse(req.body);
    const secretIds = Array.isArray(body.secretIds) && body.secretIds.length ? body.secretIds : body.secretId ? [body.secretId] : [];
    if (!secretIds.length) throw Errors.badRequest("缺少 secretId");
    if (!body.baseUrl) throw Errors.badRequest("缺少 baseUrl");

    const parsed = parseProviderModelRef(body.modelRef);
    const cat = findCatalogByRef(body.modelRef);
    const provider = (cat?.provider ?? parsed?.provider ?? "").trim();
    const model = (cat?.model ?? parsed?.model ?? "").trim();
    const modelRef = provider && model ? `${provider}:${model}` : "";
    if (!provider || !model || !modelRef) throw Errors.badRequest("modelRef 非法");
    if (!(provider === "openai" || provider === "mock" || isOpenAiCompatibleProvider(provider))) {
      throw Errors.modelProviderUnsupported(provider);
    }
    const inst = await getConnectorInstance(app.db, subject.tenantId, body.connectorInstanceId);
    if (!inst) throw Errors.badRequest("ConnectorInstance 不存在");
    if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
    if (inst.scopeType !== scope.scopeType || inst.scopeId !== scope.scopeId) throw Errors.forbidden();

    const baseUrl = provider === "mock" ? normalizeBaseUrl(body.baseUrl, "http") : normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    if (!baseUrl) throw Errors.badRequest("缺少 baseUrl");
    const chatCompletionsPath = provider === "mock" ? null : normalizeChatCompletionsPath(body.chatCompletionsPath);
    try {
      getHostFromBaseUrl(baseUrl);
    } catch {
      throw Errors.badRequest("baseUrl 非法");
    }

    const uniqSecretIds = Array.from(new Set(secretIds));
    const secrets: any[] = [];
    for (const sid of uniqSecretIds) {
      const secret = await getSecretRecord(app.db, subject.tenantId, sid);
      if (!secret) throw Errors.badRequest("Secret 不存在");
      if (secret.status !== "active") throw Errors.badRequest("Secret 未激活");
      if (secret.scopeType !== scope.scopeType || secret.scopeId !== scope.scopeId) throw Errors.forbidden();
      if (secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 与 ConnectorInstance 不匹配");
      secrets.push(secret);
    }

    const testBeforeSave = Boolean(body.testBeforeSave);
    if (testBeforeSave && provider !== "mock") {
      const testApiKeys: string[] = [];
      for (const sid of uniqSecretIds) {
        const secretEnc = await getSecretRecordEncryptedPayload(app.db, subject.tenantId, sid);
        if (!secretEnc) throw Errors.badRequest("Secret 不存在");
        let decrypted: any;
        try {
          decrypted = await decryptSecretPayload({
            pool: app.db,
            tenantId: subject.tenantId,
            masterKey: app.cfg.secrets.masterKey,
            scopeType: secretEnc.secret.scopeType,
            scopeId: secretEnc.secret.scopeId,
            keyVersion: secretEnc.secret.keyVersion,
            encFormat: secretEnc.secret.encFormat,
            encryptedPayload: secretEnc.encryptedPayload,
          });
        } catch {
          throw Errors.badRequest("密钥解密失败，无法进行连接测试");
        }
        const payloadObj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
        const apiKey = typeof payloadObj.apiKey === "string" ? payloadObj.apiKey : "";
        if (!apiKey) throw Errors.badRequest("Secret payload 缺少 apiKey");
        testApiKeys.push(apiKey);
      }
      try {
        await openAiChatWithSecretRotation({
          fetchFn: fetch,
          baseUrl,
          chatCompletionsPath: chatCompletionsPath ?? "/chat/completions",
          model,
          messages: [{ role: "user", content: "ping" }],
          apiKeys: testApiKeys,
          timeoutMs: 15000,
        });
      } catch (testErr: any) {
        const detail = testErr?.message ?? String(testErr);
        throw Errors.badRequest(`模型连接测试失败，绑定未保存: ${detail}`);
      }
    }

    const saved = await createBinding({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      modelRef,
      provider,
      model,
      baseUrl,
      chatCompletionsPath,
      connectorInstanceId: inst.id,
      secretId: secrets[0].id,
      secretIds: secrets.map((s) => s.id),
    });

    req.ctx.audit!.outputDigest = { bindingId: saved.id, modelRef: saved.modelRef, connectionTestPerformed: testBeforeSave && provider !== "mock" };
    return { scope, binding: saved, connectionTestPassed: provider === "mock" ? true : testBeforeSave };
  });

  app.delete("/models/bindings/:id", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "unbind" });
    const decision = await requirePermission({ req, resourceType: "model", action: "bind" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);

    const existing = await getBindingById(app.db, subject.tenantId, params.id);
    if (!existing) throw Errors.notFound("Binding");
    if (existing.scopeType !== scope.scopeType || existing.scopeId !== scope.scopeId) throw Errors.forbidden();

    const deleted = await deleteBinding(app.db, subject.tenantId, params.id);
    if (!deleted) throw Errors.notFound("Binding");

    req.ctx.audit!.outputDigest = { bindingId: deleted.id, modelRef: deleted.modelRef, deleted: true };
    return { deleted: true, binding: deleted };
  });
};
