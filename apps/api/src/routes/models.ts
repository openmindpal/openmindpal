import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { redactValue, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "@openslin/shared";
import { requirePermission } from "../modules/auth/guard";
import { setAuditContext } from "../modules/audit/context";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { createConnectorInstance, getConnectorInstance, getConnectorInstanceByName, getConnectorType } from "../modules/connectors/connectorRepo";
import { getQuotaLimit } from "../modules/governance/limitsRepo";
import { decryptSecretPayload, encryptSecretEnvelope } from "../modules/secrets/envelope";
import { createSecretRecord, getSecretRecord, getSecretRecordEncryptedPayload } from "../modules/secrets/secretRepo";
import { findCatalogByRef, modelCatalog, openaiCompatibleProviders } from "../modules/modelGateway/catalog";
import { createBinding, getBindingById, getBindingByModelRef, listBindings } from "../modules/modelGateway/bindingRepo";
import { isCircuitOpen, recordCircuitFailure } from "../modules/modelGateway/circuitBreaker";
import { tokenBudgetKey, getTokenBudgetUsed, incrTokenBudgetUsed } from "../modules/modelGateway/budget";
import { getEffectiveModelBudget } from "../modules/modelGateway/budgetRepo";
import { checkTenantRateLimit } from "../modules/modelGateway/rateLimit";
import { getEffectiveRoutingPolicy } from "../modules/modelGateway/routingPolicyRepo";
import { openAiChatWithSecretRotation } from "../modules/modelGateway/openaiChat";
import { extractTextForPromptInjectionScan, getPromptInjectionDenyTargetsFromEnv, getPromptInjectionModeFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../modules/safety/promptInjectionGuard";
import { isAppError } from "../lib/errors";

function resolveScope(subject: { tenantId: string; spaceId?: string | null }) {
  if (subject.spaceId) return { scopeType: "space" as const, scopeId: subject.spaceId };
  return { scopeType: "tenant" as const, scopeId: subject.tenantId };
}

function getAllowedDomains(params: { connectorEgressPolicy: any; typeDefaultEgressPolicy: any }) {
  const p = params.connectorEgressPolicy ?? params.typeDefaultEgressPolicy ?? {};
  const a = Array.isArray(p.allowedDomains) ? p.allowedDomains.filter((x: any) => typeof x === "string" && x.length) : [];
  return a as string[];
}

function isModelUpstreamError(err: unknown) {
  return Boolean(err && typeof err === "object" && "errorCode" in err && (err as any).errorCode === "MODEL_UPSTREAM_FAILED");
}

function normalizeBaseUrl(input: unknown, fallbackScheme: "http" | "https" = "https") {
  const s = String(input ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `${fallbackScheme}://${s}`;
}

function getHostFromBaseUrl(baseUrl: string) {
  const u = new URL(baseUrl);
  return u.hostname;
}

function normalizeAllowedDomains(v: unknown) {
  const arr = Array.isArray(v) ? v : [];
  const out = arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x) && !x.includes("://") && !x.includes("/") && !x.includes(":"));
  return Array.from(new Set(out));
}

function dlpRuleIdsFromSummary(summary: { hitCounts?: Record<string, number> }) {
  const hitCounts = summary?.hitCounts ?? {};
  const out: string[] = [];
  if ((hitCounts.token ?? 0) > 0) out.push("dlp.token");
  if ((hitCounts.email ?? 0) > 0) out.push("dlp.email");
  if ((hitCounts.phone ?? 0) > 0) out.push("dlp.phone");
  return out;
}

function isOpenAiCompatibleProvider(provider: string) {
  return (openaiCompatibleProviders as readonly string[]).includes(provider);
}

function parseProviderModelRef(modelRef: string) {
  const m = /^([a-z0-9_]+):(.+)$/.exec(String(modelRef ?? "").trim().toLowerCase());
  if (!m) return null;
  const provider = m[1];
  const model = String(modelRef ?? "").trim().slice(provider.length + 1);
  if (!provider || !model) return null;
  return { provider, model };
}

function normalizeOpenAiCompatibleBaseUrl(input: unknown) {
  const base = normalizeBaseUrl(input, "https");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw Errors.badRequest("baseUrl 非法");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Errors.badRequest("baseUrl 协议不支持");
  const pathNoSlash = u.pathname.replace(/\/+$/g, "");
  if (pathNoSlash.toLowerCase() === "/v1") u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/g, "");
}

type OutputSchemaFieldType = "string" | "number" | "boolean" | "json" | "datetime";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function checkOutputFieldType(type: OutputSchemaFieldType, value: unknown) {
  if (value === null || value === undefined) return true;
  if (type === "json") return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "datetime") return typeof value === "string";
  return false;
}

function parseStructuredOutputFromText(outputText: string) {
  const raw = String(outputText ?? "").trim();
  if (!raw) return { ok: false as const, reason: "empty_output" };
  const candidates = [raw];
  if (raw.startsWith("echo:")) candidates.push(raw.slice(5).trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return { ok: true as const, value: parsed as Record<string, unknown>, parseMode: candidate === raw ? "direct_json" : "echo_json" };
    } catch {
    }
  }
  return { ok: false as const, reason: "not_json_object" };
}

function validateStructuredOutput(params: {
  outputSchema: { fields: Record<string, { type: OutputSchemaFieldType; required?: boolean }> };
  outputText: string;
}) {
  const parsed = parseStructuredOutputFromText(params.outputText);
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
  const out = parsed.value;
  for (const [fieldName, def] of Object.entries(params.outputSchema.fields ?? {})) {
    const v = out[fieldName];
    if (def.required && (v === undefined || v === null)) return { ok: false as const, reason: "missing_required", field: fieldName };
    if (v !== undefined && !checkOutputFieldType(def.type, v)) return { ok: false as const, reason: "type_mismatch", field: fieldName };
  }
  return { ok: true as const, value: out, parseMode: parsed.parseMode };
}

const rateLimitLuaScript = `
  local key = KEYS[1]
  local windowMs = tonumber(ARGV[1])
  local v = redis.call('INCR', key)
  if v == 1 then
    redis.call('PEXPIRE', key, windowMs)
  end
  return v
`;

async function checkRateLimitByKey(params: { redis: any; key: string; rpm: number }) {
  const windowMs = 60_000;
  const count = (await params.redis.eval(rateLimitLuaScript, 1, params.key, String(windowMs))) as number;
  return { allowed: count <= params.rpm, remaining: Math.max(0, params.rpm - count), rpm: params.rpm, key: params.key };
}

async function writeModelUsageEvent(params: {
  pool: any;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  userId: string | null;
  scene: string | null;
  purpose: string;
  provider: string;
  modelRef: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  result: "success" | "denied" | "error";
}) {
  try {
    await params.pool.query(
      `
        INSERT INTO model_usage_events (
          tenant_id, space_id, subject_id, user_id, scene, purpose, provider, model_ref,
          prompt_tokens, completion_tokens, total_tokens, latency_ms, result
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        params.tenantId,
        params.spaceId,
        params.subjectId,
        params.userId,
        params.scene,
        params.purpose,
        params.provider,
        params.modelRef,
        params.promptTokens,
        params.completionTokens,
        params.totalTokens,
        params.latencyMs,
        params.result,
      ],
    );
  } catch (e: any) {
    if (String(e?.code ?? "") !== "42703") throw e;
    await params.pool.query(
      `
        INSERT INTO model_usage_events (
          tenant_id, space_id, subject_id, purpose, provider, model_ref,
          prompt_tokens, completion_tokens, total_tokens, latency_ms, result
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        params.tenantId,
        params.spaceId,
        params.subjectId,
        params.purpose,
        params.provider,
        params.modelRef,
        params.promptTokens,
        params.completionTokens,
        params.totalTokens,
        params.latencyMs,
        params.result,
      ],
    );
  }
}

export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.get("/models/catalog", async (req) => {
    setAuditContext(req, { resourceType: "model", action: "read" });
    const decision = await requirePermission({ req, resourceType: "model", action: "read" });
    req.ctx.audit!.policyDecision = decision;
    const openaiCompatibleProvidersOut = [...openaiCompatibleProviders];
    return {
      catalog: modelCatalog,
      templates: {
        openaiCompatible: {
          providers: openaiCompatibleProvidersOut,
          modelRefPattern: "{provider}:{modelName}",
          baseUrlRules: {
            normalize: "trim; ensure http/https; strip trailing /v1; strip query/hash; strip trailing slashes",
            endpointHost: "hostname(baseUrl) must be in allowedDomains",
          },
        },
      },
    };
  });

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
        connectorInstanceId: z.string().min(3),
        secretId: z.string().min(3).optional(),
        secretIds: z.array(z.string().min(3)).max(10).optional(),
        baseUrl: z.string().min(1).optional(),
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

    const baseUrl = normalizeBaseUrl(body.baseUrl, provider === "mock" ? "http" : "https");
    if (!baseUrl) throw Errors.badRequest("缺少 baseUrl");
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

    const saved = await createBinding({
      pool: app.db,
      tenantId: subject.tenantId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      modelRef,
      provider,
      model,
      baseUrl,
      connectorInstanceId: inst.id,
      secretId: secrets[0].id,
      secretIds: secrets.map((s) => s.id),
    });

    req.ctx.audit!.outputDigest = { bindingId: saved.id, modelRef: saved.modelRef };
    return { scope, binding: saved };
  });

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
        apiKey: z.string().min(1),
        modelName: z.string().min(1),
        connectorInstanceName: z.string().min(1).optional(),
        modelRef: z.string().min(3).max(200).optional(),
      })
      .parse(req.body);

    const normalizedBaseUrl = normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    const endpointHost = getHostFromBaseUrl(normalizedBaseUrl);

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
          VALUES ($1,$2,'create','model_onboard',NULL)
          ON CONFLICT (tenant_id, idempotency_key, operation, entity_name) DO NOTHING
        `,
        [subject.tenantId, idempotencyKey],
      );
      const idemRes = await client.query(
        `
          SELECT record_id
          FROM idempotency_records
          WHERE tenant_id = $1 AND idempotency_key = $2 AND operation = 'create' AND entity_name = 'model_onboard'
          LIMIT 1
          FOR UPDATE
        `,
        [subject.tenantId, idempotencyKey],
      );
      if (!idemRes.rowCount) throw Errors.badRequest("幂等记录缺失");
      const existingId = idemRes.rows[0].record_id ? String(idemRes.rows[0].record_id) : "";
      if (existingId) {
        const existing = await getBindingById(client, subject.tenantId, existingId);
        if (existing) {
          req.ctx.audit!.outputDigest = { bindingId: existing.id, modelRef: existing.modelRef, replay: true };
          try {
            await enqueueAuditOutboxForRequest({ client, req });
          } catch {
            throw Errors.auditOutboxWriteFailed();
          }
          await client.query("COMMIT");
          return { scope, binding: existing, modelRef: existing.modelRef, provider: existing.provider, model: existing.model, baseUrl: existing.baseUrl };
        }
      }

      let inst = await getConnectorInstanceByName(client, subject.tenantId, scope.scopeType, scope.scopeId, instanceName);
      if (inst) {
        if (inst.status !== "enabled") throw Errors.badRequest("ConnectorInstance 未启用");
        const currentAllowed = normalizeAllowedDomains(inst.egressPolicy?.allowedDomains ?? []);
        const merged = Array.from(new Set([...currentAllowed, ...allowedDomains]));
        if (merged.length !== currentAllowed.length) {
          await client.query("UPDATE connector_instances SET egress_policy = $1::jsonb, updated_at = now() WHERE tenant_id = $2 AND id = $3", [
            JSON.stringify({ allowedDomains: merged }),
            subject.tenantId,
            inst.id,
          ]);
          inst = { ...inst, egressPolicy: { allowedDomains: merged } };
        }
      } else {
        inst = await createConnectorInstance({
          pool: client,
          tenantId: subject.tenantId,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          name: instanceName,
          typeName,
          egressPolicy: { allowedDomains },
        });
      }

      const enc = await encryptSecretEnvelope({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        masterKey: app.cfg.secrets.masterKey,
        payload: { apiKey: body.apiKey },
      });
      const secret = await createSecretRecord({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        connectorInstanceId: inst.id,
        encryptedPayload: enc.encryptedPayload,
        keyVersion: enc.keyVersion,
        encFormat: enc.encFormat,
        keyRef: enc.keyRef,
      });

      const binding = await createBinding({
        pool: client,
        tenantId: subject.tenantId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        modelRef,
        provider: body.provider,
        model: canonModelName,
        baseUrl: normalizedBaseUrl,
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

      req.ctx.audit!.outputDigest = { connectorInstanceId: inst.id, secretId: secret.id, bindingId: binding.id, modelRef: binding.modelRef, provider: body.provider, endpointHost };
      try {
        await enqueueAuditOutboxForRequest({ client, req });
      } catch {
        throw Errors.auditOutboxWriteFailed();
      }
      await client.query("COMMIT");
      return { scope, binding, modelRef: binding.modelRef, provider: binding.provider, model: binding.model, baseUrl: binding.baseUrl };
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

  app.post("/models/chat", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "invoke" });
    const decision = await requirePermission({ req, resourceType: "model", action: "invoke" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const scope = resolveScope(subject);
    const body = z
      .object({
        purpose: z.string().min(1),
        modelRef: z.string().min(3).optional(),
        constraints: z
          .object({
            candidates: z.array(z.string().min(3)).max(10).optional(),
          })
          .optional(),
        scene: z.string().min(1).max(100).optional(),
        outputSchema: z
          .object({
            fields: z.record(
              z.string().min(1),
              z.object({
                type: z.enum(["string", "number", "boolean", "json", "datetime"]),
                required: z.boolean().optional(),
              }),
            ),
          })
          .optional(),
        messages: z.array(z.object({ role: z.string().min(1), content: z.string().min(0) })).min(1),
        timeoutMs: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const scene = (body.scene ? String(body.scene).trim() : body.purpose).slice(0, 100) || body.purpose;

    const piMode = getPromptInjectionModeFromEnv();
    const piDenyTargets = getPromptInjectionDenyTargetsFromEnv();
    const piText = extractTextForPromptInjectionScan(body.messages);
    const piScan = scanPromptInjection(piText);
    const piTarget = "model:invoke";
    const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, mode: piMode, target: piTarget, denyTargets: piDenyTargets });
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
    if (piDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = {
        safetySummary: { decision: "denied", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
      };
      throw Errors.safetyPromptInjectionDenied();
    }

    const dlpPolicy = resolveDlpPolicyFromEnv(process.env);
    const dlpTarget = "model:invoke";
    const promptDlp = redactValue(body.messages);
    const promptDlpDenied = shouldDenyDlpForTarget({ summary: promptDlp.summary, target: dlpTarget, policy: dlpPolicy });
    const promptDlpRuleIds = dlpRuleIdsFromSummary(promptDlp.summary);
    const promptDlpSummary = promptDlpDenied
      ? {
          ...promptDlp.summary,
          disposition: "deny" as const,
          redacted: true,
          mode: dlpPolicy.mode,
          policyVersion: dlpPolicy.version,
          target: dlpTarget,
          decision: "denied" as const,
          ruleIds: promptDlpRuleIds,
        }
      : promptDlp.summary.redacted
        ? {
            ...promptDlp.summary,
            disposition: "redact" as const,
            mode: dlpPolicy.mode,
            policyVersion: dlpPolicy.version,
            target: dlpTarget,
            decision: "allowed" as const,
            ruleIds: promptDlpRuleIds,
          }
        : {
            ...promptDlp.summary,
            mode: dlpPolicy.mode,
            policyVersion: dlpPolicy.version,
            target: dlpTarget,
            decision: "allowed" as const,
            ruleIds: promptDlpRuleIds,
          };
    if (promptDlpDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = {
        safetySummary: { decision: "denied", target: dlpTarget, ruleIds: promptDlpRuleIds, promptInjection: piSummary, dlpSummary: promptDlpSummary },
      };
      throw Errors.dlpDenied();
    }
    const redactModelPrompt = String(process.env.DLP_REDACT_MODEL_PROMPT ?? "").trim() === "1";
    const messages = redactModelPrompt && Array.isArray(promptDlp.value) ? (promptDlp.value as any[]) : body.messages;

    const quota = await getQuotaLimit({ pool: app.db, tenantId: subject.tenantId, scopeType: scope.scopeType, scopeId: scope.scopeId });
    const tenantQuota =
      scope.scopeType === "space"
        ? await getQuotaLimit({ pool: app.db, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId })
        : null;
    const rpm = quota?.modelChatRpm ?? tenantQuota?.modelChatRpm ?? Number(process.env.MODEL_RPM ?? "60");
    const tenantLimit = await checkTenantRateLimit({
      redis: app.redis,
      tenantId: subject.tenantId,
      rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 60,
    });
    const userRpmRaw = Number(process.env.MODEL_USER_RPM ?? String(rpm));
    const sceneRpmRaw = Number(process.env.MODEL_SCENE_RPM ?? String(rpm));
    const userRpm = Number.isFinite(userRpmRaw) && userRpmRaw > 0 ? userRpmRaw : Number.isFinite(rpm) && rpm > 0 ? rpm : 60;
    const sceneRpm = Number.isFinite(sceneRpmRaw) && sceneRpmRaw > 0 ? sceneRpmRaw : Number.isFinite(rpm) && rpm > 0 ? rpm : 60;
    const userLimit = subject.subjectId
      ? await checkRateLimitByKey({ redis: app.redis, key: `rl:model_chat:user:${subject.tenantId}:${subject.subjectId}`, rpm: userRpm })
      : null;
    const sceneLimit = scene
      ? await checkRateLimitByKey({ redis: app.redis, key: `rl:model_chat:scene:${subject.tenantId}:${scene}`, rpm: sceneRpm })
      : null;
    const rateLimitSummary = {
      tenant: { allowed: tenantLimit.allowed, remaining: tenantLimit.remaining, rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 60 },
      user: userLimit ? { allowed: userLimit.allowed, remaining: userLimit.remaining, rpm: userRpm } : null,
      scene: sceneLimit ? { scene, allowed: sceneLimit.allowed, remaining: sceneLimit.remaining, rpm: sceneRpm } : null,
    };
    if (!tenantLimit.allowed || (userLimit && !userLimit.allowed) || (sceneLimit && !sceneLimit.allowed)) {
      const blockedDimension = !tenantLimit.allowed ? "tenant" : userLimit && !userLimit.allowed ? "user" : "scene";
      req.ctx.audit!.errorCategory = "rate_limited";
      req.ctx.audit!.outputDigest = {
        rateLimit: rateLimitSummary,
        blockedDimension,
        safetySummary: { decision: "denied", target: dlpTarget, ruleIds: promptDlpRuleIds, promptInjection: piSummary, dlpSummary: promptDlpSummary },
      };
      return reply.status(429).send({
        errorCode: "RATE_LIMITED",
        message: { "zh-CN": "请求过于频繁", "en-US": "Too many requests" },
        dimension: blockedDimension,
        traceId: req.ctx.traceId,
      });
    }

    const budget = await getEffectiveModelBudget({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, purpose: body.purpose });
    const budgetKey = budget
      ? tokenBudgetKey({ tenantId: subject.tenantId, scopeType: budget.scopeType, scopeId: budget.scopeId, purpose: budget.purpose })
      : null;
    const budgetUsedTokens = budgetKey ? await getTokenBudgetUsed({ redis: app.redis, key: budgetKey }) : 0;
    const softDailyTokens = budget?.softDailyTokens ?? null;
    const hardDailyTokens = budget?.hardDailyTokens ?? null;
    if (budget && typeof hardDailyTokens === "number" && Number.isFinite(hardDailyTokens) && hardDailyTokens > 0 && budgetUsedTokens >= hardDailyTokens) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { budget: { scopeType: budget.scopeType, scopeId: budget.scopeId, purpose: budget.purpose, usedTokens: budgetUsedTokens, softDailyTokens, hardDailyTokens } };
      throw Errors.modelBudgetExceeded();
    }

    req.ctx.audit!.inputDigest = {
      purpose: body.purpose,
      scene,
      modelRef: body.modelRef ?? null,
      messageCount: messages.length,
      structuredOutputRequested: Boolean(body.outputSchema),
    };

    const policy = await getEffectiveRoutingPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, purpose: body.purpose });
    const policyEnabled = Boolean(policy?.enabled);

    const candidates: string[] = [];
    let routeReason = "default_binding";
    if (body.constraints?.candidates?.length) {
      routeReason = "constraints_candidates";
      candidates.push(...body.constraints.candidates);
    } else if (policyEnabled) {
      routeReason = "routing_policy";
      candidates.push(policy!.primaryModelRef, ...(policy!.fallbackModelRefs ?? []));
    } else if (body.modelRef) {
      routeReason = "explicit_modelRef";
      candidates.push(body.modelRef);
    } else {
      const b = (await listBindings(app.db, subject.tenantId, scope.scopeType, scope.scopeId))[0] ?? null;
      if (b) candidates.push(b.modelRef);
    }

    const uniqCandidates = Array.from(new Set(candidates.filter(Boolean))).slice(0, 10);
    if (!uniqCandidates.length) throw Errors.badRequest("未配置模型绑定");

    const attempts: Array<{
      modelRef: string;
      status: "success" | "skipped" | "error";
      errorCode?: string;
      reason?: string;
      secretTries?: number;
      provider?: string;
    }> = [];
    let lastPolicyViolation: { errorCode: string; message: any } | null = null;
    let lastUpstreamErr: any = null;
    let lastSelected: { provider: string; modelRef: string } | null = null;
    let lastProviderUnsupported: string | null = null;
    const softExceeded = typeof softDailyTokens === "number" && Number.isFinite(softDailyTokens) && softDailyTokens > 0 && budgetUsedTokens >= softDailyTokens;

    const cbWindowSec = Math.max(1, Number(process.env.MODEL_CB_WINDOW_SEC ?? "60"));
    const cbFailThreshold = Math.max(1, Number(process.env.MODEL_CB_FAIL_THRESHOLD ?? "5"));
    const cbOpenSec = Math.max(1, Number(process.env.MODEL_CB_OPEN_SEC ?? "30"));

    for (const modelRef of uniqCandidates) {
      if (softExceeded && attempts.length === 0 && uniqCandidates.length > 1) {
        attempts.push({ modelRef, status: "skipped", errorCode: "BUDGET_SOFT_EXCEEDED", reason: "soft_daily_tokens" });
        continue;
      }
      const circuitOpen = await isCircuitOpen({ redis: app.redis, tenantId: subject.tenantId, scope, modelRef });
      if (circuitOpen) {
        app.metrics.incModelCandidateSkipped({ reason: "circuit_open" });
        attempts.push({ modelRef, status: "skipped", errorCode: "CIRCUIT_OPEN", reason: "circuit_open" });
        continue;
      }

      const binding = await getBindingByModelRef(app.db, subject.tenantId, scope.scopeType, scope.scopeId, modelRef);
      if (!binding) {
        app.metrics.incModelCandidateSkipped({ reason: "binding_missing" });
        attempts.push({ modelRef, status: "skipped", errorCode: "BINDING_MISSING", reason: "binding_missing" });
        continue;
      }

      const cat =
        findCatalogByRef(binding.modelRef) ??
        ({
          provider: binding.provider,
          model: binding.model,
          modelRef: binding.modelRef,
          endpointHost: "",
          capabilities: { chat: true, structuredOutput: false },
          defaultLimits: { timeoutMs: 20000 },
        } as any);

      const inst = await getConnectorInstance(app.db, subject.tenantId, binding.connectorInstanceId);
      if (!inst || inst.status !== "enabled") {
        app.metrics.incModelCandidateSkipped({ reason: "connector_unavailable" });
        attempts.push({ modelRef, status: "skipped", errorCode: "CONNECTOR_UNAVAILABLE", reason: "connector_unavailable" });
        continue;
      }
      const type = await getConnectorType(app.db, inst.typeName);
      const allowedDomains = getAllowedDomains({ connectorEgressPolicy: inst.egressPolicy, typeDefaultEgressPolicy: type?.defaultEgressPolicy });
      const bindingBaseUrlRaw = (binding as any).baseUrl ?? "";
      if (!bindingBaseUrlRaw) {
        req.ctx.audit!.errorCategory = "policy_violation";
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "Base URL 缺失", "en-US": "Missing base URL" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "base_url_missing", provider: cat.provider });
        continue;
      }
      const bindingBaseUrl = normalizeBaseUrl(bindingBaseUrlRaw, cat.provider === "mock" ? "http" : "https");
      let endpointHost = cat.endpointHost;
      try {
        endpointHost = getHostFromBaseUrl(bindingBaseUrl);
      } catch {
        req.ctx.audit!.errorCategory = "policy_violation";
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "Base URL 非法", "en-US": "Invalid base URL" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "base_url_invalid", provider: cat.provider });
        continue;
      }
      if (!allowedDomains.includes(endpointHost)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "出站域名不在白名单内", "en-US": "Egress domain is not allowed" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "egress_domain_not_allowed", provider: cat.provider });
        continue;
      }

      const routingDecision = {
        provider: cat.provider,
        model: cat.model,
        modelRef: cat.modelRef,
        reason: routeReason,
        purpose: body.purpose,
        policy: policyEnabled ? { purpose: policy!.purpose, primaryModelRef: policy!.primaryModelRef, fallbackCount: policy!.fallbackModelRefs.length } : null,
        attempts: uniqCandidates.length,
        attemptIndex: attempts.length + 1,
      };
      lastSelected = { provider: cat.provider, modelRef: cat.modelRef };

      try {
        let outputText = "";
        let usage: any = { tokens: null };
        let secretTries: number | null = null;

        if (cat.provider === "mock") {
          const last = messages[messages.length - 1];
          outputText = `echo:${last.content}`;
          const promptTokens = messages.reduce((a, m) => a + Math.max(1, Math.ceil(String((m as any).content ?? "").length / 4)), 0);
          const completionTokens = Math.max(1, Math.ceil(outputText.length / 4));
          usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
        } else if (cat.provider === "openai" || isOpenAiCompatibleProvider(cat.provider)) {
          const secretIds = Array.isArray((binding as any).secretIds) && (binding as any).secretIds.length ? (binding as any).secretIds : [binding.secretId];
          const apiKeys: string[] = [];
          for (const secretId of secretIds) {
            const secret = await getSecretRecordEncryptedPayload(app.db, subject.tenantId, secretId);
            if (!secret) throw Errors.badRequest("Secret 不存在");
            if (secret.secret.status !== "active") throw Errors.badRequest("Secret 未激活");
            if (secret.secret.scopeType !== scope.scopeType || secret.secret.scopeId !== scope.scopeId) throw Errors.forbidden();
            if (secret.secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 与 ConnectorInstance 不匹配");

            let decrypted: any;
            try {
              decrypted = await decryptSecretPayload({
                pool: app.db,
                tenantId: subject.tenantId,
                masterKey: app.cfg.secrets.masterKey,
                scopeType: secret.secret.scopeType,
                scopeId: secret.secret.scopeId,
                keyVersion: secret.secret.keyVersion,
                encFormat: secret.secret.encFormat,
                encryptedPayload: secret.encryptedPayload,
              });
            } catch (e: any) {
              const msg = String(e?.message ?? "");
              if (msg === "key_disabled") throw Errors.keyDisabled();
              throw Errors.keyDecryptFailed();
            }
            const payloadObj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
            const apiKey = typeof payloadObj.apiKey === "string" ? payloadObj.apiKey : "";
            if (!apiKey) throw Errors.badRequest("Secret payload 缺少 apiKey");
            apiKeys.push(apiKey);
          }

          const timeoutMs = body.timeoutMs ?? cat.defaultLimits.timeoutMs;
          const result = await openAiChatWithSecretRotation({
            fetchFn: fetch,
            baseUrl: bindingBaseUrl,
            model: cat.model,
            messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
            apiKeys,
            timeoutMs,
          });
          outputText = result.outputText;
          usage = result.usage;
          secretTries = result.secretTries;
        } else {
          lastProviderUnsupported = cat.provider;
          attempts.push({ modelRef, status: "skipped", errorCode: "PROVIDER_NOT_IMPLEMENTED", reason: cat.provider, provider: cat.provider });
          app.metrics.incModelCandidateSkipped({ reason: "provider_unsupported" });
          continue;
        }

        let structuredOutput: Record<string, unknown> | null = null;
        let structuredOutputSummary: { status: "ok" | "invalid"; reason?: string; field?: string; parseMode?: string; fieldCount?: number } | null = null;
        if (body.outputSchema) {
          const validation = validateStructuredOutput({ outputSchema: body.outputSchema, outputText });
          if (!validation.ok) {
            req.ctx.audit!.errorCategory = "validation_failed";
            const latencyMs = req.ctx.audit?.startedAtMs ? Date.now() - req.ctx.audit.startedAtMs : null;
            const reason = validation.reason;
            const field = "field" in validation ? validation.field : undefined;
            attempts.push({ modelRef, status: "error", errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED", reason, provider: cat.provider });
            structuredOutputSummary = field ? { status: "invalid", reason, field } : { status: "invalid", reason };
            req.ctx.audit!.outputDigest = {
              routingDecision,
              rateLimit: rateLimitSummary,
              budget: budgetKey ? { scopeType: budget?.scopeType, scopeId: budget?.scopeId, purpose: budget?.purpose, usedTokens: budgetUsedTokens, softDailyTokens, hardDailyTokens } : null,
              outputTextLen: outputText.length,
              attempts,
              structuredOutput: structuredOutputSummary,
              safetySummary: { decision: "allowed", target: dlpTarget, ruleIds: promptDlpRuleIds, promptInjection: piSummary, dlpSummary: promptDlpSummary },
            };
            await writeModelUsageEvent({
              pool: app.db,
              tenantId: subject.tenantId,
              spaceId: subject.spaceId ?? null,
              subjectId: subject.subjectId,
              userId: subject.subjectId,
              scene,
              purpose: body.purpose,
              provider: cat.provider,
              modelRef: cat.modelRef,
              promptTokens: null,
              completionTokens: null,
              totalTokens: null,
              latencyMs: typeof latencyMs === "number" ? latencyMs : null,
              result: "error",
            });
            app.metrics.incModelChat({ result: "error" });
            return reply.status(422).send({
              errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED",
              message: { "zh-CN": "模型输出不满足 outputSchema", "en-US": "Model output does not satisfy outputSchema" },
              details: { reason, field: field ?? null },
              traceId: req.ctx.traceId,
            });
          }
          structuredOutput = validation.value;
          structuredOutputSummary = { status: "ok", parseMode: validation.parseMode, fieldCount: Object.keys(body.outputSchema.fields ?? {}).length };
        }

        const st = typeof secretTries === "number" && Number.isFinite(secretTries) ? secretTries : undefined;
        attempts.push(st != null ? { modelRef, status: "success", secretTries: st, provider: cat.provider } : { modelRef, status: "success", provider: cat.provider });
        app.metrics.incModelChat({ result: "success" });
        const latencyMs = req.ctx.audit?.startedAtMs ? Date.now() - req.ctx.audit.startedAtMs : null;
        const promptTokens = usage && typeof usage === "object" ? ((usage as any).prompt_tokens ?? null) : null;
        const completionTokens = usage && typeof usage === "object" ? ((usage as any).completion_tokens ?? null) : null;
        const totalTokens = usage && typeof usage === "object" ? ((usage as any).total_tokens ?? null) : null;
        await writeModelUsageEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId ?? null,
          subjectId: subject.subjectId,
          userId: subject.subjectId,
          scene,
          purpose: body.purpose,
          provider: cat.provider,
          modelRef: cat.modelRef,
          promptTokens: typeof promptTokens === "number" ? promptTokens : null,
          completionTokens: typeof completionTokens === "number" ? completionTokens : null,
          totalTokens: typeof totalTokens === "number" ? totalTokens : null,
          latencyMs: typeof latencyMs === "number" ? latencyMs : null,
          result: "success",
        });
        if (budgetKey) {
          const delta = typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
          await incrTokenBudgetUsed({ redis: app.redis, key: budgetKey, delta, ttlMs: 48 * 60 * 60 * 1000 });
        }
        req.ctx.audit!.outputDigest = {
          routingDecision,
          rateLimit: rateLimitSummary,
          budget: budgetKey ? { scopeType: budget?.scopeType, scopeId: budget?.scopeId, purpose: budget?.purpose, usedTokens: budgetUsedTokens, softDailyTokens, hardDailyTokens } : null,
          usage:
            usage && typeof usage === "object"
              ? { promptTokens: (usage as any).prompt_tokens ?? null, completionTokens: (usage as any).completion_tokens ?? null, totalTokens: (usage as any).total_tokens ?? null }
              : { tokens: null },
          latencyMs,
          outputTextLen: outputText.length,
          structuredOutput: structuredOutputSummary,
          attempts,
          safetySummary: { decision: "allowed", target: dlpTarget, ruleIds: promptDlpRuleIds, promptInjection: piSummary, dlpSummary: promptDlpSummary },
        };
        return {
          outputText,
          output: structuredOutput,
          routingDecision,
          usage: usage ?? { tokens: null },
          latencyMs,
          rateLimit: rateLimitSummary,
          traceId: req.ctx.traceId,
        };
      } catch (e: any) {
        if (isModelUpstreamError(e)) {
          req.ctx.audit!.errorCategory = "upstream_error";
          lastUpstreamErr = e;
          attempts.push({ modelRef, status: "error", errorCode: "MODEL_UPSTREAM_FAILED", reason: "upstream_failed", provider: cat.provider });
          await recordCircuitFailure({
            redis: app.redis,
            tenantId: subject.tenantId,
            scope,
            modelRef,
            windowSec: cbWindowSec,
            failThreshold: cbFailThreshold,
            openSec: cbOpenSec,
          });
          continue;
        }
        throw e;
      }
    }

    req.ctx.audit!.outputDigest = { attempts, rateLimit: rateLimitSummary, safetySummary: { decision: "denied", promptInjection: piSummary, promptDlpSummary } };
    if (lastPolicyViolation) {
      app.metrics.incModelChat({ result: "denied" });
      await writeModelUsageEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        subjectId: subject.subjectId,
        userId: subject.subjectId,
        scene,
        purpose: body.purpose,
        provider: lastSelected?.provider ?? "unknown",
        modelRef: lastSelected?.modelRef ?? uniqCandidates[0] ?? "unknown",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        latencyMs: req.ctx.audit?.startedAtMs ? Date.now() - req.ctx.audit.startedAtMs : null,
        result: "denied",
      });
      return reply.status(403).send({ errorCode: lastPolicyViolation.errorCode, message: lastPolicyViolation.message, traceId: req.ctx.traceId });
    }
    if (lastUpstreamErr) {
      app.metrics.incModelChat({ result: "error" });
      await writeModelUsageEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        subjectId: subject.subjectId,
        userId: subject.subjectId,
        scene,
        purpose: body.purpose,
        provider: lastSelected?.provider ?? "unknown",
        modelRef: lastSelected?.modelRef ?? uniqCandidates[0] ?? "unknown",
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        latencyMs: req.ctx.audit?.startedAtMs ? Date.now() - req.ctx.audit.startedAtMs : null,
        result: "error",
      });
      throw lastUpstreamErr;
    }
    if (attempts.length && attempts.every((a) => a.errorCode === "PROVIDER_NOT_IMPLEMENTED")) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.modelProviderNotImplemented(lastProviderUnsupported ?? undefined);
    }
    throw Errors.badRequest("未配置可用的模型绑定");
  });
};
