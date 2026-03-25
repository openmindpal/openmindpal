import crypto from "node:crypto";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { nl2uiRequestSchema, nl2uiGeneratedConfigSchema, type Nl2UiGeneratedConfig } from "./types";
import { listUiComponentRegistryComponentIds, isComponentAllowed } from "../../ui-page-config/modules/componentRegistry";

// ─── T11: NL2UI 组件白名单 ─────────────────────────────────────────────────
// DynamicBlockRenderer 可渲染的 componentId 集合
const NL2UI_ALLOWED_COMPONENTS = new Set([
  "DataGrid",
  "KanbanBoard",
  "BlockEditor",
  "BiDashboard",
  "CardList",
  "ChartWidget",
  "TimelineWidget",
  "CalendarWidget",
  "StatsRow",
]);

const NL2UI_DEFAULT_COMPONENT = "DataGrid";

/**
 * T11: 校验并修正生成配置中的 componentId
 * 未知组件一律降级为 DataGrid (architecture-01 §D2)
 */
function enforceComponentWhitelistOnConfig(config: Nl2UiGeneratedConfig): Nl2UiGeneratedConfig {
  let patched = false;
  const areas = config.ui.layout.areas.map((area) => {
    if (NL2UI_ALLOWED_COMPONENTS.has(area.componentId)) return area;
    console.warn(`[NL2UI] componentId "${area.componentId}" not in whitelist, downgrading to ${NL2UI_DEFAULT_COMPONENT}`);
    patched = true;
    return { ...area, componentId: NL2UI_DEFAULT_COMPONENT };
  });
  if (!patched) return config;
  return {
    ...config,
    ui: { ...config.ui, layout: { ...config.ui.layout, areas } },
  };
}

// ─── T12: Effective Schema field discovery ──────────────────────────────

/**
 * T12: 为每个实体获取 Effective Schema，确保只使用用户有权限的字段
 */
async function discoverEntityFields(
  app: FastifyInstance,
  authorization: string,
  entityNames: string[],
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  await Promise.allSettled(
    entityNames.map(async (entity) => {
      try {
        const res = await app.inject({
          method: "GET",
          url: `/schemas/${encodeURIComponent(entity)}/effective?schemaName=core`,
          headers: { authorization, "content-type": "application/json" },
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = JSON.parse(res.body);
          const fields = body?.fields;
          if (fields && typeof fields === "object") {
            result[entity] = Object.keys(fields);
          }
        }
      } catch { /* best effort */ }
    }),
  );
  return result;
}

/**
 * T12: 生成后裁剪 — 移除 sort/filter 中引用了用户无权限字段
 */
function enforceFieldSecurity(
  config: Nl2UiGeneratedConfig,
  entityFieldMap: Record<string, string[]>,
): Nl2UiGeneratedConfig {
  if (Object.keys(entityFieldMap).length === 0) return config;
  const systemFields = ["createdAt", "updatedAt", "id"];

  let patched = false;
  const dataBindings = config.dataBindings.map((db) => {
    const entityName = db.params?.entityName;
    const allowedFields = entityName ? entityFieldMap[entityName] : null;
    if (!allowedFields) return db;

    let newDb = db;

    // Strip sort if field is not readable
    if (db.sort && !allowedFields.includes(db.sort.field) && !systemFields.includes(db.sort.field)) {
      console.warn(`[NL2UI] T12: sort field "${db.sort.field}" not in effective schema for ${entityName}, removing`);
      newDb = { ...newDb, sort: undefined };
      patched = true;
    }

    // Strip filters referencing unreadable fields
    if (db.filters && typeof db.filters === "object" && Object.keys(db.filters).length > 0) {
      const safeFilters: Record<string, any> = {};
      for (const [field, cond] of Object.entries(db.filters)) {
        if (allowedFields.includes(field) || systemFields.includes(field)) {
          safeFilters[field] = cond;
        } else {
          console.warn(`[NL2UI] T12: filter field "${field}" not in effective schema for ${entityName}, stripping`);
          patched = true;
        }
      }
      newDb = { ...newDb, filters: safeFilters };
    }

    return newDb;
  });

  if (!patched) return config;
  return { ...config, dataBindings };
}

// ─── Entity Discovery ────────────────────────────────────────────────────

async function discoverAvailableEntities(pool: Pool, tenantId: string): Promise<string[]> {
  try {
    const res = await pool.query(
      `SELECT DISTINCT s.schema_json
       FROM schemas s
       LEFT JOIN schema_active_versions av ON av.tenant_id = $1 AND av.name = s.name
       WHERE s.status = 'released'
         AND (av.active_version IS NULL OR s.version = av.active_version)
       ORDER BY s.schema_json->>'name' ASC
       LIMIT 20`,
      [tenantId],
    );
    const entityNames: string[] = [];
    for (const row of res.rows) {
      const schema = row.schema_json;
      if (schema?.entities && typeof schema.entities === "object") {
        for (const name of Object.keys(schema.entities)) {
          if (!entityNames.includes(name)) entityNames.push(name);
        }
      }
    }
    return entityNames;
  } catch {
    return [];
  }
}

// ─── LLM Call ────────────────────────────────────────────────────────────

/** P0: 最低置信度阈值，低于此值的生成结果自动降级到普通对话 */
const NL2UI_CONFIDENCE_THRESHOLD = 0.4;

/**
 * P0: 构建 NL2UI System Prompt
 * 向大模型注入组件白名单、布局枚举、数据绑定格式、意图判别规则
 */
function buildNl2UiSystemPrompt(params: {
  availableEntities: string[];
  entityFieldMap?: Record<string, string[]>;
  stylePrefs?: any;
}): string {
  const components = Array.from(NL2UI_ALLOWED_COMPONENTS).join(", ");
  const layouts = ["single-column", "split-horizontal", "split-vertical", "grid"];

  let entitySection = "";
  if (params.availableEntities.length > 0) {
    entitySection = `\n可用实体: ${params.availableEntities.join(", ")}`;
    if (params.entityFieldMap && Object.keys(params.entityFieldMap).length > 0) {
      const lines = Object.entries(params.entityFieldMap)
        .map(([e, f]) => `  ${e}: ${f.join(", ")}`);
      entitySection += `\n实体字段:\n${lines.join("\n")}`;
    }
  } else {
    entitySection = `\n【重要 — 当前无可用实体】
当前系统尚未配置任何实体。你必须：
1. dataBindings 设为空数组 []，area.dataBindingIds 也设为空数组 []。严禁编造实体名。
2. 在每个 area 的 props 中提供 mockItems 数组，内容必须贴合用户意图和该组件的语义，不要用固定的示例数据。
   mockItems 格式: [{ "id": "...", "title": "...", "description": "...", "value": ..., "status": "ok"|"warning"|"alert", "createdAt": "ISO日期" }]
   - StatsRow: 每个 item 对应一个指标卡片，用 title+value+description
   - ChartWidget: 用 title 做标签、value 做数值
   - CardList: 用 title+description
   - KanbanBoard: 用 title+description+status(分栏)
   - TimelineWidget/CalendarWidget: 用 title+description+createdAt
   - DataGrid: 用全字段
3. mockItems 内容必须是中文，且要与用户请求的场景匹配（如用户要笔记页就生成笔记相关数据，要任务看板就生成任务相关数据）。
4. 每个 area 至少提供 3-6 条 mockItems。`;
  }

  let styleSection = "";
  if (params.stylePrefs) {
    styleSection = `\n用户样式偏好: ${JSON.stringify(params.stylePrefs)}`;
  }

  return `你是 UI 生成引擎。根据用户描述生成 JSON 配置。
意图: intent="ui"(生成界面) 或 "chat"(闲聊)。始终返回 intent + confidence(0-1)。
组件: ${components}
布局: ${layouts.join(", ")}${entitySection}${styleSection}
输出纯 JSON:
{"intent":"ui"|"chat","confidence":0-1,"ui":{"layout":{"variant":"...","areas":[{"name":"...","componentId":"...","props":{"title":"...","mockItems":[]},"dataBindingIds":[]}]},"blocks":[]},"dataBindings":[],"replyText":"...","suggestions":[],"metadata":{"generatedAt":"ISO","modelUsed":"nl2ui","confidence":0.85}}
规则: intent=chat 只返回 {intent,confidence,replyText}。无可用实体时 dataBindings=[]，props 提供 3-6 条中文 mockItems。componentId 必须在组件列表中。只返回纯 JSON，禁止 markdown 包裹。`;
}

/** P1c: 从缓存中读取之前的生成结果 */
async function readCachedGeneration(
  pool: Pool,
  context: { userId: string; tenantId: string },
  userInput: string,
): Promise<Nl2UiGeneratedConfig | null> {
  try {
    const hash = crypto.createHash("sha256").update(userInput).digest("hex");
    const res = await pool.query(
      `SELECT generated_config FROM nl2ui_generation_cache
       WHERE tenant_id = $1 AND user_id = $2 AND user_input_hash = $3
         AND expires_at > NOW()
       LIMIT 1`,
      [context.tenantId, context.userId, hash],
    );
    if (res.rowCount && res.rowCount > 0 && res.rows[0]?.generated_config) {
      return nl2uiGeneratedConfigSchema.safeParse(res.rows[0].generated_config).data ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

async function callLlmForUiGeneration(params: {
  app: FastifyInstance;
  userInput: string;
  authorization: string;
  traceId?: string;
  availableEntities: string[];
  previousConfig?: any;
  entityFieldMap?: Record<string, string[]>;
  stylePrefs?: any;
  timeoutMs?: number;
}): Promise<Nl2UiGeneratedConfig | null> {
  const systemPrompt = buildNl2UiSystemPrompt({
    availableEntities: params.availableEntities,
    entityFieldMap: params.entityFieldMap,
    stylePrefs: params.stylePrefs,
  });

  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: params.userInput },
  ];

  const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? Math.max(1_000, Math.round(params.timeoutMs)) : 30_000;

  try {
    const res = await params.app.inject({
      method: "POST",
      url: "/models/chat",
      headers: {
        authorization: params.authorization,
        "content-type": "application/json",
        "x-user-locale": "zh-CN",
        ...(params.traceId ? { "x-trace-id": `${params.traceId}-nl2ui` } : {}),
      },
      payload: {
        purpose: "nl2ui.generate",
        messages,
        timeoutMs,
        temperature: 0,
        maxTokens: 4096,
      },
    });

    if (res.statusCode === 429) {
      let payload: any = null;
      try {
        payload = res.body ? JSON.parse(res.body) : null;
      } catch {}
      const err: any = new Error("RATE_LIMITED");
      err.statusCode = 429;
      err.payload =
        payload && typeof payload === "object"
          ? payload
          : { errorCode: "RATE_LIMITED", message: { "zh-CN": "请求过于频繁", "en-US": "Too many requests" }, traceId: params.traceId };
      throw err;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      let payload: any = null;
      try {
        payload = res.body ? JSON.parse(res.body) : null;
      } catch {}
      const err: any = new Error("MODEL_GATEWAY_ERROR");
      err.statusCode = res.statusCode;
      err.payload =
        payload && typeof payload === "object"
          ? {
            errorCode: String((payload as any).errorCode ?? `MODEL_GATEWAY_${res.statusCode}`),
            message: (payload as any).message ?? { "zh-CN": "模型调用失败", "en-US": "Model request failed" },
            traceId: String((payload as any).traceId ?? params.traceId ?? ""),
            ...(Number.isFinite(Number((payload as any).retryAfterSec)) ? { retryAfterSec: Number((payload as any).retryAfterSec) } : {}),
          }
          : { errorCode: `MODEL_GATEWAY_${res.statusCode}`, message: { "zh-CN": "模型调用失败", "en-US": "Model request failed" }, traceId: String(params.traceId ?? "") };
      throw err;
    }

    const body = res.body ? JSON.parse(res.body) : null;
    const outputText = typeof body?.outputText === "string" ? body.outputText : "";
    if (!outputText) {
      const err: any = new Error("NL2UI_EMPTY_OUTPUT");
      err.statusCode = 502;
      err.payload = { errorCode: "NL2UI_EMPTY_OUTPUT", message: { "zh-CN": "界面生成失败：模型未返回内容", "en-US": "UI generation failed: empty model output" }, traceId: String(params.traceId ?? "") };
      throw err;
    }

    // 提取 JSON
    let jsonStr = outputText.trim();
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(jsonStr);
    if (fenceMatch) jsonStr = fenceMatch[1]!.trim();
    const firstBrace = jsonStr.indexOf("{");
    const lastBrace = jsonStr.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      const err: any = new Error("NL2UI_PARSE_ERROR");
      err.statusCode = 502;
      err.payload = { errorCode: "NL2UI_PARSE_ERROR", message: { "zh-CN": "界面生成失败：模型返回格式无法解析", "en-US": "UI generation failed: could not parse model output" }, traceId: String(params.traceId ?? "") };
      throw err;
    }

    // P0: 意图判别 — 如果大模型判定为普通聊天，直接返回 null 降级到对话流
    if (parsed.intent === "chat") {
      console.info(`[NL2UI] intent=chat, 降级到普通对话: "${params.userInput.slice(0, 60)}"`);
      return null;
    }

    // P0: confidence 过滤 — 低置信度结果也降级
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : (parsed.metadata?.confidence ?? 1);
    if (confidence < NL2UI_CONFIDENCE_THRESHOLD) {
      console.info(`[NL2UI] confidence=${confidence} < ${NL2UI_CONFIDENCE_THRESHOLD}, 降级到普通对话`);
      return null;
    }

    // 删除辅助字段，避免 schema 校验失败
    delete parsed.intent;
    delete parsed.confidence;

    // 填充必要的 metadata 默认值
    if (!parsed.metadata) parsed.metadata = {};
    if (!parsed.metadata.generatedAt) parsed.metadata.generatedAt = new Date().toISOString();
    if (!parsed.metadata.modelUsed) parsed.metadata.modelUsed = "nl2ui-llm-v1";
    if (typeof parsed.metadata.confidence !== "number") parsed.metadata.confidence = confidence;
    if (!parsed.ui?.blocks) {
      if (!parsed.ui) parsed.ui = { layout: parsed.ui?.layout, blocks: [] };
      else parsed.ui.blocks = [];
    }

    // 使用 safeParse 增强容错
    const result = nl2uiGeneratedConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error("[NL2UI] Schema validation failed:", JSON.stringify(result.error.issues, null, 2));
      const err: any = new Error("NL2UI_SCHEMA_INVALID");
      err.statusCode = 502;
      err.payload = { errorCode: "NL2UI_SCHEMA_INVALID", message: { "zh-CN": "界面生成失败：生成结果不符合配置规范", "en-US": "UI generation failed: invalid config schema" }, traceId: String(params.traceId ?? "") };
      throw err;
    }
    return result.data;
  } catch (err: any) {
    if (err && typeof err === "object" && ((err as any).statusCode === 429 || (err as any).payload)) throw err;
    console.error("[NL2UI] LLM generation failed:", err?.message ?? err);
    const e: any = new Error("NL2UI_ERROR");
    e.statusCode = 502;
    e.payload = { errorCode: "NL2UI_ERROR", message: { "zh-CN": "界面生成异常", "en-US": "UI generation error" }, traceId: String(params.traceId ?? "") };
    throw e;
  }
}

// ─── Prefetch: 预取 NL2UI 上下文（与对话 LLM 并行）──────────────────────

export type Nl2UiPrefetchedContext = {
  availableEntities: string[];
  stylePrefs: any;
  cached: Nl2UiGeneratedConfig | null;
};

/**
 * 预取 NL2UI 所需的上下文数据（实体发现 + 样式偏好 + 缓存检查）。
 * 在编排器中与对话 LLM 调用并行启动，节省 ~200-500ms 预处理时间。
 * 失败时静默降级，不阻塞主流程。
 */
export async function prefetchNl2UiContext(
  pool: Pool,
  context: { userId: string; tenantId: string },
  userInput: string,
  stylePrefsOverride?: any,
  hasPreviousConfig?: boolean,
): Promise<Nl2UiPrefetchedContext> {
  try {
    const stylePrefsPromise = stylePrefsOverride
      ? Promise.resolve(stylePrefsOverride)
      : pool.query(
          `SELECT pref_value FROM memory_user_preferences
           WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'nl2ui.style_prefs'
           LIMIT 1`,
          [context.tenantId, context.userId],
        ).then((r) => (r.rowCount && r.rowCount > 0 ? r.rows[0].pref_value : null)).catch(() => null);

    const cachePromise = hasPreviousConfig
      ? Promise.resolve(null)
      : readCachedGeneration(pool, context, userInput);

    const [availableEntities, stylePrefs, cached] = await Promise.all([
      discoverAvailableEntities(pool, context.tenantId),
      stylePrefsPromise,
      cachePromise,
    ]);
    return { availableEntities, stylePrefs, cached };
  } catch {
    return { availableEntities: [], stylePrefs: null, cached: null };
  }
}

// ─── Main Generator Function ─────────────────────────────────────────────

export async function generateUiFromNaturalLanguage(
  pool: Pool,
  request: {
    userInput: string;
    context: { userId: string; tenantId: string; spaceId?: string };
    stylePrefs?: any;
    previousConfig?: any;
  },
  options?: {
    app?: FastifyInstance;
    authorization?: string;
    traceId?: string;
  },
  /** 预取的上下文（来自 prefetchNl2UiContext），跳过重复的预处理 */
  prefetched?: Nl2UiPrefetchedContext | null,
): Promise<Nl2UiGeneratedConfig | null> {
  // 如果有预取数据，直接使用；否则执行并行预处理
  let availableEntities: string[];
  let stylePrefs: any;
  let cached: Nl2UiGeneratedConfig | null;

  if (prefetched) {
    availableEntities = prefetched.availableEntities;
    stylePrefs = request.stylePrefs || prefetched.stylePrefs;
    cached = prefetched.cached;
  } else {
    // 1. 并行: 发现实体 + 加载样式偏好 + 缓存读取
    const stylePrefsPromise = request.stylePrefs
      ? Promise.resolve(request.stylePrefs)
      : pool.query(
          `SELECT pref_value FROM memory_user_preferences
           WHERE tenant_id = $1 AND subject_id = $2 AND pref_key = 'nl2ui.style_prefs'
           LIMIT 1`,
          [request.context.tenantId, request.context.userId],
        ).then((r) => (r.rowCount && r.rowCount > 0 ? r.rows[0].pref_value : null)).catch(() => null);

    const cachePromise = request.previousConfig
      ? Promise.resolve(null)
      : readCachedGeneration(pool, request.context, request.userInput);

    [availableEntities, stylePrefs, cached] = await Promise.all([
      discoverAvailableEntities(pool, request.context.tenantId),
      stylePrefsPromise,
      cachePromise,
    ]);
  }

  // 1b. 缓存命中 — 直接返回（跳过后续所有步骤）
  // 注意：只在没有 previousConfig 且输入完全一致时才使用缓存
  if (cached && !request.previousConfig) {
    console.info(`[NL2UI] 命中缓存: "${request.userInput.slice(0, 40)}"`);
    let out: Nl2UiGeneratedConfig = cached;
    if (stylePrefs) out = { ...out, appliedStylePrefs: stylePrefs };
    out = enforceComponentWhitelistOnConfig(out);
    return out;
  } else if (cached) {
    console.info(`[NL2UI] 有缓存但携带 previousConfig，跳过缓存重新生成: "${request.userInput.slice(0, 40)}"`);
  }

  // 1c. T12: 获取每个实体的 Effective Schema 字段列表（仅缓存未命中时执行）
  let entityFieldMap: Record<string, string[]> = {};
  if (options?.app && options?.authorization && availableEntities.length > 0) {
    entityFieldMap = await discoverEntityFields(options.app, options.authorization, availableEntities);
  }

  // 3. 调用大模型生成 UI 配置
  if (!options?.app || !options?.authorization) {
    throw new Error("NL2UI 生成需要 app 实例和认证信息");
  }

  const rawTimeout = Number(process.env.NL2UI_MODEL_TIMEOUT_MS ?? "");
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.round(rawTimeout) : 90_000;
  const maxRetries = 1; // 超时自动重试一次

  let config: Nl2UiGeneratedConfig | null = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.info(`[NL2UI] 开始生成 (attempt=${attempt + 1}/${maxRetries + 1}): input="${request.userInput.slice(0, 60)}", entities=${availableEntities.length}, timeout=${timeoutMs}ms`);
      config = await callLlmForUiGeneration({
        app: options.app,
        userInput: request.userInput,
        authorization: options.authorization,
        traceId: options.traceId,
        availableEntities,
        previousConfig: request.previousConfig,
        entityFieldMap,
        stylePrefs,
        timeoutMs,
      });
      lastErr = null;
      break;
    } catch (err: any) {
      lastErr = err;
      const payload = err && typeof err === "object" ? (err as any).payload : null;
      const errorCode = payload ? String(payload.errorCode ?? "") : "";
      const isTimeout = errorCode.includes("UPSTREAM_FAILED") && (String(payload?.message?.["zh-CN"] ?? "").includes("timeout") || String(payload?.message?.["en-US"] ?? "").includes("timeout"));
      const msgZh = payload && typeof payload.message === "object" ? String(payload.message["zh-CN"] ?? "") : payload ? String(payload.message ?? "") : "";
      const msgEn = payload && typeof payload.message === "object" ? String(payload.message["en-US"] ?? "") : "";
      console.error(`[NL2UI] 生成失败 (attempt=${attempt + 1}): errorCode=${errorCode}, msg=${msgZh || msgEn || String(err?.message ?? err)}, statusCode=${(err as any)?.statusCode ?? "?"}, isTimeout=${isTimeout}`);

      // 仅对超时错误重试，其他错误（如限流、解析失败等）立即抛出
      if (!isTimeout || attempt >= maxRetries) {
        // 超时错误：提供更友好的提示
        if (isTimeout && err.payload) {
          err.payload = {
            ...err.payload,
            errorCode: "NL2UI_TIMEOUT",
            message: {
              "zh-CN": "界面生成超时，页面内容较复杂，请稍后重试或简化描述（如拆分为多步）",
              "en-US": "UI generation timed out. The page is complex — please retry later or simplify the description.",
            },
          };
        }
        throw err;
      }
      console.info(`[NL2UI] 超时后自动重试...`);
    }
  }
  if (lastErr) throw lastErr;

  if (!config) return null;

  let finalConfig: Nl2UiGeneratedConfig = config;

  if (stylePrefs) {
    finalConfig.appliedStylePrefs = stylePrefs;
  }

  // 5. T11: 组件白名单校验 — 降级未知组件
  finalConfig = enforceComponentWhitelistOnConfig(finalConfig);

  // 6. T12: 字段级安全 — 裁剪 sort/filter 中无权限的字段
  finalConfig = enforceFieldSecurity(finalConfig, entityFieldMap);



  // 7. 缓存生成结果
  await cacheGeneration(pool, request.context, request.userInput, finalConfig);

  return finalConfig;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

async function cacheGeneration(
  pool: Pool,
  context: { userId: string; tenantId: string; spaceId?: string },
  userInput: string,
  config: Nl2UiGeneratedConfig,
) {
  try {
    const hash = crypto.createHash("sha256").update(userInput).digest("hex");
    await pool.query(
      `INSERT INTO nl2ui_generation_cache (
         tenant_id, user_id, user_input_hash, generated_config, created_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 day')
       ON CONFLICT (tenant_id, user_id, user_input_hash)
       DO UPDATE SET generated_config = EXCLUDED.generated_config, expires_at = NOW() + INTERVAL '1 day'`,
      [context.tenantId, context.userId, hash, JSON.stringify(config)],
    );
  } catch (error) {
    console.error("Failed to cache NL2UI generation:", error);
  }
}
