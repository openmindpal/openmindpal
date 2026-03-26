import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors, isAppError } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../../modules/audit/requestOutbox";
import { encryptSecretEnvelope } from "../../modules/secrets/envelope";
import { createSecretRecord } from "../../modules/secrets/secretRepo";
import { createConnectorInstance, getConnectorInstanceByName, getConnectorType } from "../connector-manager/modules/connectorRepo";
import { createBinding } from "./modules/bindingRepo";
import { openAiChatWithSecretRotation } from "./modules/openaiChat";
import {
  getHostFromBaseUrl,
  normalizeAllowedDomains,
  normalizeChatCompletionsPath,
  normalizeOpenAiCompatibleBaseUrl,
  resolveScope,
} from "./modules/helpers";

export const modelOnboardRoutes: FastifyPluginAsync = async (app) => {
  app.post("/models/onboard", async (req) => {
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? (req.headers["x-idempotency-key"] as string | undefined) ?? "";
    setAuditContext(req, { resourceType: "model", action: "onboard", requireOutbox: true, idempotencyKey: idempotencyKey || undefined });

    const connectorDecision = await requirePermission({ req, resourceType: "connector", action: "create" });
    const secretDecision = await requirePermission({ req, resourceType: "secret", action: "create" });
    const modelDecision = await requirePermission({ req, resourceType: "model", action: "bind" });
    req.ctx.audit!.policyDecision = { connectorCreate: connectorDecision, secretCreate: secretDecision, modelBind: modelDecision };

    if (!idempotencyKey) throw Errors.badRequest("缺少 idempotency-key");

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        provider: z.enum(["openai_compatible", "deepseek", "hunyuan", "qianwen", "doubao", "zhipu", "kimi", "kimimax"]),
        baseUrl: z.string().min(1),
        chatCompletionsPath: z.string().max(200).optional(),
        apiKey: z.string().min(1),
        modelName: z.string().min(1),
        connectorInstanceName: z.string().min(1).optional(),
        modelRef: z.string().min(3).max(200).optional(),
      })
      .parse(req.body);
    const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    const endpointHost = getHostFromBaseUrl(normalizedBaseUrl);
    const chatCompletionsPath = normalizeChatCompletionsPath(body.chatCompletionsPath);

    const canonModelName = body.modelName.trim();
    if (!canonModelName) throw Errors.badRequest("缺少 modelName");

    const computedModelRef = `${body.provider}:${canonModelName.replace(/\s+/g, "-")}`;
    const modelRef = (body.modelRef ?? computedModelRef).trim();
    if (!/^[a-zA-Z0-9._:-]+$/.test(modelRef)) throw Errors.badRequest("modelRef 非法");

    const instanceName = (body.connectorInstanceName ?? `model-${body.provider}-${endpointHost}`).trim();
    if (!instanceName) throw Errors.badRequest("connectorInstanceName 非法");

    const typeName = "model.openai";
    const type = await getConnectorType(app.db, typeName);
    if (!type) throw Errors.badRequest("连接器类型不存在");

    const defaultAllowed = normalizeAllowedDomains(type.defaultEgressPolicy?.allowedDomains ?? []);
    const allowedDomains = Array.from(new Set([...defaultAllowed, endpointHost].map((x) => String(x).trim().toLowerCase()).filter(Boolean)));

    const client = await app.db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO idempotency_records (tenant_id, idempotency_key, operation, entity_name, record_id)
          VALUES ($1, $2, 'create', 'model_onboard', NULL)
          ON CONFLICT (tenant_id, idempotency_key, operation, entity_name)
          DO NOTHING
        `,
        [subject.tenantId, idempotencyKey],
      );

      const idemRow = await client.query(
        `
          SELECT record_id
          FROM idempotency_records
          WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = 'create' AND entity_name = 'model_onboard'
          LIMIT 1
        `,
        [subject.tenantId, idempotencyKey],
      );
      const existingBindingId = idemRow.rowCount ? (idemRow.rows[0].record_id as string | null) : null;
      if (existingBindingId) {
        const bindingRow = await client.query(
          `SELECT * FROM provider_bindings WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [subject.tenantId, existingBindingId],
        );
        if (!bindingRow.rowCount) throw Errors.notFound("binding");
        const binding = bindingRow.rows[0];
        req.ctx.audit!.outputDigest = { bindingId: binding.id, modelRef: binding.model_ref, provider: binding.provider, endpointHost, idempotent: true };
        try {
          await enqueueAuditOutboxForRequest({ client, req });
        } catch {
          throw Errors.auditOutboxWriteFailed();
        }
        await client.query("COMMIT");
        return { scope, binding: { id: binding.id, modelRef: binding.model_ref, provider: binding.provider, model: binding.model, baseUrl: binding.base_url, chatCompletionsPath: binding.chat_completions_path }, modelRef: binding.model_ref, provider: binding.provider, model: binding.model, baseUrl: binding.base_url, connectionTestPassed: true };
      }

      const existingInst = await getConnectorInstanceByName(client, subject.tenantId, scope.scopeType, scope.scopeId, instanceName);
      const inst =
        existingInst ??
        (await createConnectorInstance({
          pool: client,
          tenantId: subject.tenantId,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          typeName,
          name: instanceName,
          egressPolicy: { allowedDomains },
        }));

      const secretEnvelope = await encryptSecretEnvelope({
        pool: client,
        tenantId: subject.tenantId,
        masterKey: app.cfg.secrets.masterKey,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        payload: { apiKey: body.apiKey },
      });

      const secret = await createSecretRecord({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        connectorInstanceId: inst.id,
        encFormat: secretEnvelope.encFormat,
        keyVersion: secretEnvelope.keyVersion,
        encryptedPayload: secretEnvelope.encryptedPayload,
      });

      try {
        await openAiChatWithSecretRotation({
          fetchFn: fetch,
          baseUrl: normalizedBaseUrl,
          chatCompletionsPath: chatCompletionsPath ?? "/chat/completions",
          model: canonModelName,
          messages: [{ role: "user", content: "ping" }],
          apiKeys: [body.apiKey],
          timeoutMs: 15000,
        });
      } catch (testErr: any) {
        const detail = testErr?.message ?? String(testErr);
        throw Errors.badRequest(`模型连接测试失败，未保存: ${detail}`);
      }

      const binding = await createBinding({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        modelRef,
        provider: body.provider,
        model: canonModelName,
        baseUrl: normalizedBaseUrl,
        chatCompletionsPath,
        connectorInstanceId: inst.id,
        secretId: secret.id,
      });

      await client.query(
        `
          UPDATE idempotency_records
          SET record_id = $3
          WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = 'create' AND entity_name = 'model_onboard'
        `,
        [subject.tenantId, idempotencyKey, binding.id],
      );

      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, secretId: secret.id, bindingId: binding.id, modelRef: binding.modelRef, provider: body.provider, endpointHost, connectionTestPerformed: true };
      try {
        await enqueueAuditOutboxForRequest({ client, req });
      } catch {
        throw Errors.auditOutboxWriteFailed();
      }
      await client.query("COMMIT");
      return { scope, binding, modelRef: binding.modelRef, provider: binding.provider, model: binding.model, baseUrl: binding.baseUrl, connectionTestPassed: true };
    } catch (e: any) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      if (isAppError(e)) throw e;
      const pgCode = typeof e?.code === "string" ? e.code : "";
      if (pgCode === "23505") throw Errors.badRequest("记录已存在");
      throw e;
    } finally {
      client.release();
    }
  });
};
