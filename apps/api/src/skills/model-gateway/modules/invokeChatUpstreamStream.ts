import { AppError, Errors } from "../../../lib/errors";
import { redactValue, resolveDlpPolicy, resolveDlpPolicyFromEnv, resolvePromptInjectionPolicy, shouldDenyDlpForTarget } from "@openslin/shared";
import { decryptSecretPayload } from "../../../modules/secrets/envelope";
import { getSecretRecordEncryptedPayload } from "../../../modules/secrets/secretRepo";
import { writeSecretUsageEvent } from "../../../modules/secrets/usageRepo";
import { getConnectorInstance, getConnectorType } from "../../connector-manager/modules/connectorRepo";
import { getEffectiveSafetyPolicyVersion } from "../../safety-policy/modules/safetyPolicyRepo";
import {
  extractTextForPromptInjectionScan,
  getPromptInjectionPolicyFromEnv,
  scanPromptInjection,
  shouldDenyPromptInjectionForTarget,
  summarizePromptInjection,
} from "../../safety-policy/modules/promptInjectionGuard";
import { findCatalogByRef, isOpenAiCompatibleProvider as isOpenAiCompatProviderFromCatalog } from "./catalog";
import { getBindingByModelRef, listBindings } from "./bindingRepo";
import { getEffectiveRoutingPolicy } from "../../../modules/modelGateway/routingPolicyRepo";
import { openAiChatStreamWithSecretRotation, openAiChatWithSecretRotation } from "./openaiChat";
import {
  dlpRuleIdsFromSummary,
  getAllowedDomains,
  getHostFromBaseUrl,
  hasDlpEnvOverride,
  isModelUpstreamError,
  isOpenAiCompatibleProvider,
  isPlainObject,
  normalizeBaseUrl,
  normalizeOpenAiCompatibleBaseUrl,
  resolveScope,
  type OutputSchemaFieldType,
} from "./helpers";

function validateStructuredOutput(params: {
  outputSchema: { fields: Record<string, { type: OutputSchemaFieldType; required?: boolean }> };
  outputText: string;
}) {
  const schema = params.outputSchema?.fields ?? {};
  if (!isPlainObject(schema)) return { ok: false as const, reason: "schema_invalid" as const };

  const text = String(params.outputText ?? "").trim();
  if (!text) return { ok: false as const, reason: "empty_output" as const };

  let parsed: any = null;
  let parseMode: "json" | "codeblock" | "raw" = "raw";
  try {
    parsed = JSON.parse(text);
    parseMode = "json";
  } catch {
    const m = /```json\s*([\s\S]*?)\s*```/i.exec(text);
    if (m && m[1]) {
      try {
        parsed = JSON.parse(m[1]);
        parseMode = "codeblock";
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return { ok: false as const, reason: "json_parse_failed" as const };

  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema)) {
    const t = def?.type;
    const required = Boolean(def?.required);
    const v = (parsed as any)[k];
    if (v === undefined || v === null) {
      if (required) return { ok: false as const, reason: "missing_required" as const, field: k };
      continue;
    }
    if (t === "string") {
      if (typeof v !== "string") return { ok: false as const, reason: "type_mismatch" as const, field: k };
      out[k] = v;
    } else if (t === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) return { ok: false as const, reason: "type_mismatch" as const, field: k };
      out[k] = v;
    } else if (t === "boolean") {
      if (typeof v !== "boolean") return { ok: false as const, reason: "type_mismatch" as const, field: k };
      out[k] = v;
    } else if (t === "datetime") {
      const s = String(v ?? "");
      const d = new Date(s);
      if (!s || Number.isNaN(d.getTime())) return { ok: false as const, reason: "type_mismatch" as const, field: k };
      out[k] = s;
    } else if (t === "json") {
      out[k] = v;
    } else {
      return { ok: false as const, reason: "schema_invalid" as const };
    }
  }
  return { ok: true as const, value: out, parseMode };
}

async function writeModelUsageEvent(params: {
  pool: any;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  userId: string;
  scene: string;
  purpose: string;
  provider: string;
  modelRef: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  result: "success" | "error" | "denied";
}) {
  await params.pool.query(
    `
      INSERT INTO model_usage_events (
        tenant_id, space_id, subject_id, user_id, scene, purpose,
        provider, model_ref, prompt_tokens, completion_tokens, total_tokens, latency_ms, result
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
}

export async function invokeModelChatUpstreamStream(params: {
  app: any;
  subject: { tenantId: string; spaceId?: string | null; subjectId: string };
  body: {
    purpose: string;
    modelRef?: string;
    constraints?: { candidates?: string[] };
    scene?: string;
    outputSchema?: { fields: Record<string, { type: OutputSchemaFieldType; required?: boolean }> };
    messages: Array<{ role: string; content: string }>;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
  };
  traceId?: string | null;
  requestId?: string | null;
  locale: string;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onUsage?: (usage: any) => void;
}) {
  const subject = params.subject;
  const scope = resolveScope(subject);
  const body = params.body;
  const scene = (body.scene ? String(body.scene).trim() : body.purpose).slice(0, 100) || body.purpose;

  const injEff = await getEffectiveSafetyPolicyVersion({ pool: params.app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, policyType: "injection" });
  const piPolicy = injEff?.policyJson ? resolvePromptInjectionPolicy(injEff.policyJson as any) : getPromptInjectionPolicyFromEnv();
  const piMode = piPolicy.mode;
  const piText = extractTextForPromptInjectionScan(body.messages);
  const piScan = scanPromptInjection(piText);
  const piTarget = "model:invoke";
  const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, policy: piPolicy, target: piTarget });
  const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
  if (piDenied) {
    const err = Errors.safetyPromptInjectionDenied();
    (err as any).audit = {
      errorCategory: "policy_violation",
      outputDigest: {
        safetySummary: {
          decision: "denied",
          target: piTarget,
          ruleIds: piSummary.ruleIds,
          promptInjection: piSummary,
          ...(injEff?.policyDigest ? { policyRefsDigest: { injectionPolicyDigest: String(injEff.policyDigest) } } : {}),
        },
      },
    };
    throw err;
  }

  const contentEff = await getEffectiveSafetyPolicyVersion({ pool: params.app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, policyType: "content" });
  const envDlpOverride = hasDlpEnvOverride(process.env);
  const dlpPolicy = envDlpOverride ? resolveDlpPolicyFromEnv(process.env) : contentEff?.policyJson ? resolveDlpPolicy(contentEff.policyJson as any) : resolveDlpPolicyFromEnv(process.env);
  const dlpTarget = "model:invoke";
  const promptDlp = redactValue(body.messages);
  const promptDlpDenied = shouldDenyDlpForTarget({ summary: promptDlp.summary, target: dlpTarget, policy: dlpPolicy });
  const promptDlpRuleIds = dlpRuleIdsFromSummary(promptDlp.summary);
  const promptDlpSummary = promptDlpDenied
    ? { ...promptDlp.summary, disposition: "deny" as const, redacted: true, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "denied" as const, ruleIds: promptDlpRuleIds }
    : promptDlp.summary.redacted
      ? { ...promptDlp.summary, disposition: "redact" as const, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "allowed" as const, ruleIds: promptDlpRuleIds }
      : { ...promptDlp.summary, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "allowed" as const, ruleIds: promptDlpRuleIds };
  if (promptDlpDenied) {
    const err = Errors.dlpDenied();
    (err as any).audit = {
      errorCategory: "policy_violation",
      outputDigest: {
        safetySummary: {
          decision: "denied",
          target: dlpTarget,
          ruleIds: promptDlpRuleIds,
          promptInjection: piSummary,
          dlpSummary: promptDlpSummary,
          ...((!envDlpOverride && contentEff?.policyDigest) || injEff?.policyDigest
            ? { policyRefsDigest: { ...(!envDlpOverride && contentEff?.policyDigest ? { contentPolicyDigest: String(contentEff.policyDigest) } : {}), ...(injEff?.policyDigest ? { injectionPolicyDigest: String(injEff.policyDigest) } : {}) } }
            : {}),
        },
      },
    };
    throw err;
  }

  const redactModelPrompt = String(process.env.DLP_REDACT_MODEL_PROMPT ?? "").trim() === "1";
  const messages = redactModelPrompt && Array.isArray(promptDlp.value) ? (promptDlp.value as any[]) : body.messages;

  const candidates: string[] = [];
  let routeReason = "default_binding";
  if (body.constraints?.candidates?.length) {
    routeReason = "constraints_candidates";
    candidates.push(...body.constraints.candidates);
  } else if (body.modelRef) {
    routeReason = "explicit_modelRef";
    candidates.push(body.modelRef);
  } else {
    // Check routing policy first
    const policy = await getEffectiveRoutingPolicy({ pool: params.app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, purpose: body.purpose });
    const policyEnabled = Boolean(policy?.enabled);
    if (policyEnabled && policy!.primaryModelRef) {
      routeReason = "routing_policy";
      candidates.push(policy!.primaryModelRef, ...(policy!.fallbackModelRefs ?? []));
    } else {
      // Fallback to default binding
      const b = (await listBindings(params.app.db, subject.tenantId, scope.scopeType, scope.scopeId))[0] ?? null;
      if (b) candidates.push(b.modelRef);
    }
  }
  const uniqCandidates = Array.from(new Set(candidates.filter(Boolean))).slice(0, 10);
  if (!uniqCandidates.length) throw Errors.badRequest("未配置模型绑定");

  const attempts: Array<{ modelRef: string; status: "success" | "skipped" | "error"; errorCode?: string; reason?: string; secretTries?: number; provider?: string }> = [];
  let lastPolicyViolation: { errorCode: string; message: any } | null = null;
  let lastUpstreamErr: any = null;
  let lastSelected: { provider: string; modelRef: string } | null = null;
  let lastProviderUnsupported: string | null = null;

  const startedAtMs = Date.now();

  for (const modelRef of uniqCandidates) {
    const binding = await getBindingByModelRef(params.app.db, subject.tenantId, scope.scopeType, scope.scopeId, modelRef);
    if (!binding) {
      params.app.metrics.incModelCandidateSkipped({ reason: "binding_missing" });
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
        defaultLimits: { timeoutMs: 15000 },
      } as any);

    const inst = await getConnectorInstance(params.app.db, subject.tenantId, binding.connectorInstanceId);
    if (!inst || inst.status !== "enabled") {
      params.app.metrics.incModelCandidateSkipped({ reason: "connector_unavailable" });
      attempts.push({ modelRef, status: "skipped", errorCode: "CONNECTOR_UNAVAILABLE", reason: "connector_unavailable" });
      continue;
    }
    const type = await getConnectorType(params.app.db, inst.typeName);
    const allowedDomains = getAllowedDomains({ connectorEgressPolicy: inst.egressPolicy, typeDefaultEgressPolicy: type?.defaultEgressPolicy });
    const bindingBaseUrlRaw = (binding as any).baseUrl ?? (binding as any).base_url ?? "";
    let bindingBaseUrl: string | null = null;
    let endpointHost = cat.endpointHost;
    if (cat.provider === "mock") {
      if (bindingBaseUrlRaw) {
        bindingBaseUrl = normalizeBaseUrl(bindingBaseUrlRaw, "http");
        try {
          endpointHost = getHostFromBaseUrl(bindingBaseUrl);
        } catch {
          lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "Base URL 非法", "en-US": "Invalid base URL" } };
          attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "base_url_invalid", provider: cat.provider });
          continue;
        }
        if (!allowedDomains.includes(endpointHost)) {
          lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "出站域名不在白名单内", "en-US": "Egress domain is not allowed" } };
          attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "egress_domain_not_allowed", provider: cat.provider });
          continue;
        }
      }
    } else {
      if (!bindingBaseUrlRaw) {
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "Base URL 缺失", "en-US": "Missing base URL" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "base_url_missing", provider: cat.provider });
        continue;
      }
      bindingBaseUrl = normalizeOpenAiCompatibleBaseUrl(bindingBaseUrlRaw);
      try {
        endpointHost = getHostFromBaseUrl(bindingBaseUrl);
      } catch {
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "Base URL 非法", "en-US": "Invalid base URL" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "base_url_invalid", provider: cat.provider });
        continue;
      }
      if (!allowedDomains.includes(endpointHost)) {
        lastPolicyViolation = { errorCode: "POLICY_VIOLATION", message: { "zh-CN": "出站域名不在白名单内", "en-US": "Egress domain is not allowed" } };
        attempts.push({ modelRef, status: "error", errorCode: "POLICY_VIOLATION", reason: "egress_domain_not_allowed", provider: cat.provider });
        continue;
      }
    }

    const routingDecision = { provider: cat.provider, model: cat.model, modelRef: cat.modelRef, reason: routeReason, purpose: body.purpose, policy: null, attempts: uniqCandidates.length, attemptIndex: attempts.length + 1 };
    lastSelected = { provider: cat.provider, modelRef: cat.modelRef };

    try {
      let outputText = "";
      let usage: any = { tokens: null };
      let secretTries: number | null = null;

      if (cat.provider === "mock") {
        const combined = messages.map((m: any) => String((m as any)?.content ?? "")).join("\n");
        const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
        const lastUserContent = String((lastUser as any)?.content ?? "");
        const suggestIntent = /(新建|创建|写入|保存|搜索|查找|search|create|write|save)/i.test(lastUserContent);
        if (/```tool_call/i.test(combined) && suggestIntent) {
          const refs: string[] = [];
          const re = /-\s+([a-zA-Z0-9._:-]+@\d+)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(combined)) !== null) refs.push(String(m[1]));
          const picked = refs.find((r) => r.startsWith("entity.create@")) ?? refs[0] ?? "entity.create@1";
          const toolName = picked.split("@")[0] ?? "";
          let inputDraft: any = {};
          if (toolName === "entity.create") {
            inputDraft = { schemaName: "core", entityName: "notes", payload: { title: "note" } };
          }
          outputText = `我可以用 ${picked} 来处理这个请求。\n\`\`\`tool_call\n${JSON.stringify([{ toolRef: picked, inputDraft }])}\n\`\`\``;
        } else {
          const last = messages[messages.length - 1];
          const lastContent = String((last as any)?.content ?? "");
          const t = lastContent.trim();
          outputText =
            (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))
              ? t
              : `echo:${lastContent}`;
        }
        params.onDelta(outputText);
        const promptTokens = messages.reduce((a: number, m: any) => a + Math.max(1, Math.ceil(String((m as any).content ?? "").length / 4)), 0);
        const completionTokens = Math.max(1, Math.ceil(outputText.length / 4));
        usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
      } else if (cat.provider === "openai" || isOpenAiCompatibleProvider(cat.provider) || isOpenAiCompatProviderFromCatalog(cat.provider)) {
        const secretIds = Array.isArray((binding as any).secretIds) && (binding as any).secretIds.length ? (binding as any).secretIds : [binding.secretId];
        const apiKeys: string[] = [];
        const secretMetas: Array<{ secretId: string; credentialVersion: number }> = [];
        for (const secretId of secretIds) {
          const secret = await getSecretRecordEncryptedPayload(params.app.db, subject.tenantId, secretId);
          if (!secret) throw Errors.badRequest("Secret 不存在");
          if (secret.secret.status !== "active") throw Errors.badRequest("Secret 未激活");
          if (secret.secret.scopeType !== scope.scopeType || secret.secret.scopeId !== scope.scopeId) throw Errors.forbidden();
          if (secret.secret.connectorInstanceId !== inst.id) throw Errors.badRequest("Secret 与 ConnectorInstance 不匹配");

          let decrypted: any;
          try {
            decrypted = await decryptSecretPayload({
              pool: params.app.db,
              tenantId: subject.tenantId,
              masterKey: params.app.cfg.secrets.masterKey,
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
          secretMetas.push({ secretId: secret.secret.id, credentialVersion: secret.secret.credentialVersion });
        }

        const effTimeoutMs =
          typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
            ? Math.max(1, Math.min(120_000, Math.round(body.timeoutMs)))
            : Math.max(1, Math.min(120_000, Math.round(Number(cat.defaultLimits?.timeoutMs ?? 15_000))));
        const tries = await (async () => {
          if (body.stream) {
            const ctrl = new AbortController();
            const onAbort = () => ctrl.abort();
            if (params.signal) {
              if (params.signal.aborted) ctrl.abort();
              else params.signal.addEventListener("abort", onAbort, { once: true });
            }
            /* Timeout only applies until first delta arrives; clear once streaming starts */
            let streamStarted = false;
            const timer = setTimeout(() => { if (!streamStarted) ctrl.abort(); }, effTimeoutMs);
            const usageFromStream: any = {};
            let result: any;
            try {
              result = await openAiChatStreamWithSecretRotation({
                fetchFn: fetch,
                baseUrl: bindingBaseUrl!,
                chatCompletionsPath: binding.chatCompletionsPath ?? (binding as any).chat_path ?? "/chat/completions",
                model: cat.model,
                messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
                apiKeys,
                ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
                ...(typeof body.maxTokens === "number" ? { maxTokens: body.maxTokens } : {}),
                signal: ctrl.signal,
                onDelta: (t: string) => {
                  if (!streamStarted) { streamStarted = true; clearTimeout(timer); }
                  outputText += t;
                  params.onDelta(t);
                },
                onUsage: (u: any) => {
                  if (u && typeof u === "object") Object.assign(usageFromStream, u);
                  if (params.onUsage) params.onUsage(u);
                },
              });
            } finally {
              if (params.signal) params.signal.removeEventListener("abort", onAbort);
              clearTimeout(timer);
            }
            secretTries = result.secretTries;
            usage = Object.keys(usageFromStream).length ? usageFromStream : { tokens: null };
            return typeof result.secretTries === "number" && Number.isFinite(result.secretTries) ? Math.max(1, Math.min(secretMetas.length, Math.round(result.secretTries))) : null;
          }
          const result = await openAiChatWithSecretRotation({
            fetchFn: fetch,
            baseUrl: bindingBaseUrl!,
            chatCompletionsPath: binding.chatCompletionsPath ?? (binding as any).chat_path ?? "/chat/completions",
            model: cat.model,
            messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
            apiKeys,
            timeoutMs: effTimeoutMs,
            ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
            ...(typeof body.maxTokens === "number" ? { maxTokens: body.maxTokens } : {}),
          });
          secretTries = result.secretTries;
          usage = result.usage ?? { tokens: null };
          outputText = String(result.outputText ?? "");
          params.onDelta(outputText);
          return typeof result.secretTries === "number" && Number.isFinite(result.secretTries) ? Math.max(1, Math.min(secretMetas.length, Math.round(result.secretTries))) : null;
        })();
        if (tries) {
          const used = secretMetas[tries - 1];
          if (used?.secretId) {
            await writeSecretUsageEvent({
              pool: params.app.db,
              tenantId: subject.tenantId,
              scopeType: scope.scopeType,
              scopeId: scope.scopeId,
              connectorInstanceId: inst.id,
              secretId: used.secretId,
              credentialVersion: used.credentialVersion,
              scene,
              result: "success",
              traceId: params.traceId ?? "",
              requestId: params.requestId ?? "",
            });
          }
        }
      } else {
        lastProviderUnsupported = cat.provider;
        const err = Errors.modelProviderUnsupported(String(cat.provider ?? ""));
        lastPolicyViolation = { errorCode: err.errorCode, message: err.messageI18n };
        attempts.push({ modelRef, status: "error", errorCode: err.errorCode, reason: "provider_unsupported", provider: String(cat.provider ?? "") });
        continue;
      }

      let structuredOutput: Record<string, unknown> | null = null;
      if (body.outputSchema) {
        const validation = validateStructuredOutput({ outputSchema: body.outputSchema, outputText });
        if (!validation.ok) {
          attempts.push({ modelRef, status: "error", errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED", reason: validation.reason, provider: cat.provider });
          const latencyMs = Date.now() - startedAtMs;
          await writeModelUsageEvent({
            pool: params.app.db,
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
            latencyMs,
            result: "error",
          });
          const err = new AppError({
            errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED",
            httpStatus: 422,
            message: { "zh-CN": "模型输出不满足 outputSchema", "en-US": "Model output does not satisfy outputSchema" },
          });
          (err as any).details = { reason: validation.reason, field: "field" in validation ? (validation as any).field : null };
          throw err;
        }
        structuredOutput = validation.value;
      }

      const st = typeof secretTries === "number" && Number.isFinite(secretTries) ? secretTries : undefined;
      attempts.push(st != null ? { modelRef, status: "success", secretTries: st, provider: cat.provider } : { modelRef, status: "success", provider: cat.provider });
      params.app.metrics.incModelChat({ result: "success" });
      const latencyMs = Date.now() - startedAtMs;
      const promptTokens = usage && typeof usage === "object" ? ((usage as any).prompt_tokens ?? null) : null;
      const completionTokens = usage && typeof usage === "object" ? ((usage as any).completion_tokens ?? null) : null;
      const totalTokens = usage && typeof usage === "object" ? ((usage as any).total_tokens ?? null) : null;
      await writeModelUsageEvent({
        pool: params.app.db,
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
        latencyMs,
        result: "success",
      });
      return {
        outputText,
        output: structuredOutput,
        routingDecision,
        usage: usage ?? { tokens: null },
        latencyMs,
        attempts,
        scene,
        safetySummary: { decision: "allowed", target: dlpTarget, ruleIds: promptDlpRuleIds, promptInjection: piSummary, dlpSummary: promptDlpSummary },
        policyRefsDigest: { ...(!envDlpOverride && contentEff?.policyDigest ? { contentPolicyDigest: String(contentEff.policyDigest) } : {}), ...(injEff?.policyDigest ? { injectionPolicyDigest: String(injEff.policyDigest) } : {}) },
      };
    } catch (e: any) {
      if (isModelUpstreamError(e)) {
        lastUpstreamErr = e;
        attempts.push({ modelRef, status: "error", errorCode: "MODEL_UPSTREAM_FAILED", reason: "upstream_failed", provider: cat.provider });
        continue;
      }
      throw e;
    }
  }

  if (lastPolicyViolation) {
    params.app.metrics.incModelChat({ result: "denied" });
    await writeModelUsageEvent({
      pool: params.app.db,
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
      latencyMs: Date.now() - startedAtMs,
      result: "denied",
    });
    const err = new AppError({ errorCode: lastPolicyViolation.errorCode, httpStatus: 403, message: lastPolicyViolation.message });
    (err as any).audit = { errorCategory: "policy_violation", outputDigest: { attempts } };
    throw err;
  }
  if (lastUpstreamErr) {
    params.app.metrics.incModelChat({ result: "error" });
    await writeModelUsageEvent({
      pool: params.app.db,
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
      latencyMs: Date.now() - startedAtMs,
      result: "error",
    });
    throw lastUpstreamErr;
  }
  throw Errors.badRequest(lastProviderUnsupported ? `模型提供方不支持: ${lastProviderUnsupported}` : "未配置可用的模型绑定");
}
