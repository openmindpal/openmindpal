import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { openSse } from "../../lib/sse";
import { invokeModelChatUpstreamStream } from "./modules/invokeChatUpstreamStream";

export const modelChatRoutes: FastifyPluginAsync = async (app) => {
  function wantsEventStream(req: any, body: any) {
    return Boolean(body?.stream) || String((req.headers.accept as string | undefined) ?? "").toLowerCase().includes("text/event-stream");
  }

  async function handleChatStream(req: any, reply: any, body: any) {
    setAuditContext(req, { resourceType: "model", action: "invoke.stream" });

    const sse = openSse({ req, reply });

    let outputTextLen = 0;
    let usageFromStream: any = null;
    try {
      sse.sendEvent("status", { phase: "started" });
      const out = await invokeModelChatUpstreamStream({
        app,
        subject: req.ctx.subject!,
        body,
        locale: req.ctx.locale ?? "zh-CN",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        signal: sse.signal,
        onDelta: (t) => {
          outputTextLen += t.length;
          sse.sendEvent("delta", { text: t });
        },
        onUsage: (u) => {
          usageFromStream = u;
        },
      });

      req.ctx.audit!.inputDigest = { purpose: body.purpose, scene: out.scene, modelRef: body.modelRef ?? null, messageCount: body.messages.length, structuredOutputRequested: Boolean(body.outputSchema) };
      req.ctx.audit!.outputDigest = {
        routingDecision: out.routingDecision,
        usage:
          usageFromStream && typeof usageFromStream === "object"
            ? { promptTokens: (usageFromStream as any).prompt_tokens ?? null, completionTokens: (usageFromStream as any).completion_tokens ?? null, totalTokens: (usageFromStream as any).total_tokens ?? null }
            : out.usage && typeof out.usage === "object"
              ? { promptTokens: (out.usage as any).prompt_tokens ?? null, completionTokens: (out.usage as any).completion_tokens ?? null, totalTokens: (out.usage as any).total_tokens ?? null }
              : { tokens: null },
        latencyMs: out.latencyMs ?? null,
        outputTextLen,
        attempts: out.attempts,
        safetySummary: out.safetySummary,
      };

      sse.sendEvent("done", {
        outputTextLen,
        routingDecision: out.routingDecision,
        usage: usageFromStream ?? out.usage ?? { tokens: null },
        latencyMs: out.latencyMs ?? null,
        traceId: req.ctx.traceId,
      });
    } catch (err: any) {
      const code = err?.errorCode ?? "INTERNAL_ERROR";
      const msg = err?.messageI18n ?? err?.message ?? "Unknown error";
      const retryAfterSec = Number(err?.retryAfterSec);
      const details = err && typeof err === "object" && "details" in err ? (err as any).details : undefined;
      if (err && typeof err === "object" && (err as any).audit) {
        const a = (err as any).audit;
        if (a?.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a?.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
      } else {
        req.ctx.audit!.errorCategory = "internal";
        req.ctx.audit!.outputDigest = { errorCode: code };
      }
      sse.sendEvent("error", { errorCode: code, message: msg, traceId: req.ctx.traceId, ...(details ? { details } : {}), ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {}) });
    } finally {
      sse.close();
    }
  }

  const bodySchema = z.object({
    purpose: z.string().min(1),
    stream: z.boolean().optional(),
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
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(32768).optional(),
  });

  app.post("/models/chat", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "invoke" });
    const decision = await requirePermission({ req, resourceType: "model", action: "invoke" });
    req.ctx.audit!.policyDecision = decision;

    const body = bodySchema.parse(req.body);

    const budgetPrefixRaw = String((req.headers["x-budget-purpose-prefix"] as string | undefined) ?? "").trim();
    const budgetMaxTokensRaw = String((req.headers["x-budget-max-tokens"] as string | undefined) ?? "").trim();
    const budgetMaxCostUsdRaw = String((req.headers["x-budget-max-cost-usd"] as string | undefined) ?? "").trim();
    const budgetPrefix = budgetPrefixRaw && budgetPrefixRaw.length <= 120 ? budgetPrefixRaw : "";
    const budgetMaxTokens = budgetMaxTokensRaw ? Number(budgetMaxTokensRaw) : NaN;
    const budgetMaxCostUsd = budgetMaxCostUsdRaw ? Number(budgetMaxCostUsdRaw) : NaN;
    if (budgetPrefix && Number.isFinite(budgetMaxTokens) && budgetMaxTokens > 0) {
      const like = `${budgetPrefix}:%`;
      const res = await app.db.query(
        `
          SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total
          FROM model_usage_events
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR space_id = $2)
            AND purpose LIKE $3
            AND created_at >= (now() - interval '14 days')
        `,
        [req.ctx.subject!.tenantId, req.ctx.subject!.spaceId ?? null, like],
      );
      const used = Number(res.rowCount ? res.rows[0].total : 0) || 0;
      const remaining = Math.max(0, Math.floor(budgetMaxTokens - used));
      if (remaining <= 0) {
        req.ctx.audit!.errorCategory = "policy_violation";
        req.ctx.audit!.outputDigest = { errorCode: "MODEL_BUDGET_EXCEEDED", budget: { prefix: budgetPrefix, maxTokens: budgetMaxTokens, usedTokens: used } };
        return reply.status(429).send({
          errorCode: "MODEL_BUDGET_EXCEEDED",
          message: { "zh-CN": "模型调用已超过 token 预算，已拒绝", "en-US": "Model invocation exceeded token budget" },
          details: { budgetPrefix, maxTokens: budgetMaxTokens, usedTokens: used },
          traceId: req.ctx.traceId,
        });
      }
      const requestedMaxTokens = body.maxTokens && Number.isFinite(body.maxTokens) ? body.maxTokens : null;
      const eff = requestedMaxTokens ? Math.max(1, Math.min(requestedMaxTokens, remaining)) : remaining;
      (body as any).maxTokens = eff;
    }
    if (budgetPrefix && Number.isFinite(budgetMaxCostUsd) && budgetMaxCostUsd > 0) {
      const usdPer1kTokens = Number(String(process.env.MODEL_USD_PER_1K_TOKENS ?? "").trim());
      if (Number.isFinite(usdPer1kTokens) && usdPer1kTokens > 0) {
        const like = `${budgetPrefix}:%`;
        const res = await app.db.query(
          `
            SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total
            FROM model_usage_events
            WHERE tenant_id = $1
              AND ($2::text IS NULL OR space_id = $2)
              AND purpose LIKE $3
              AND created_at >= (now() - interval '14 days')
          `,
          [req.ctx.subject!.tenantId, req.ctx.subject!.spaceId ?? null, like],
        );
        const usedTokens = Number(res.rowCount ? res.rows[0].total : 0) || 0;
        const usedCostUsd = (usedTokens / 1000) * usdPer1kTokens;
        if (usedCostUsd >= budgetMaxCostUsd) {
          req.ctx.audit!.errorCategory = "policy_violation";
          req.ctx.audit!.outputDigest = { errorCode: "MODEL_BUDGET_EXCEEDED", budget: { prefix: budgetPrefix, maxCostUsd: budgetMaxCostUsd, usdPer1kTokens, usedTokens, usedCostUsd } };
          return reply.status(429).send({
            errorCode: "MODEL_BUDGET_EXCEEDED",
            message: { "zh-CN": "模型调用已超过成本预算，已拒绝", "en-US": "Model invocation exceeded cost budget" },
            details: { budgetPrefix, maxCostUsd: budgetMaxCostUsd, usdPer1kTokens, usedTokens, usedCostUsd },
            traceId: req.ctx.traceId,
          });
        }
        const remainingCostUsd = Math.max(0, budgetMaxCostUsd - usedCostUsd);
        const remainingTokens = Math.max(0, Math.floor((remainingCostUsd * 1000) / usdPer1kTokens));
        if (remainingTokens <= 0) {
          req.ctx.audit!.errorCategory = "policy_violation";
          req.ctx.audit!.outputDigest = { errorCode: "MODEL_BUDGET_EXCEEDED", budget: { prefix: budgetPrefix, maxCostUsd: budgetMaxCostUsd, usdPer1kTokens, usedTokens, usedCostUsd } };
          return reply.status(429).send({
            errorCode: "MODEL_BUDGET_EXCEEDED",
            message: { "zh-CN": "模型调用已超过成本预算，已拒绝", "en-US": "Model invocation exceeded cost budget" },
            details: { budgetPrefix, maxCostUsd: budgetMaxCostUsd, usdPer1kTokens, usedTokens, usedCostUsd },
            traceId: req.ctx.traceId,
          });
        }
        const requestedMaxTokens = body.maxTokens && Number.isFinite(body.maxTokens) ? body.maxTokens : null;
        const eff = requestedMaxTokens ? Math.max(1, Math.min(requestedMaxTokens, remainingTokens)) : remainingTokens;
        (body as any).maxTokens = eff;
      }
    }
    if (wantsEventStream(req, body)) {
      await handleChatStream(req, reply, {
        purpose: body.purpose,
        modelRef: body.modelRef,
        constraints: body.constraints,
        scene: body.scene,
        outputSchema: body.outputSchema,
        messages: body.messages,
        timeoutMs: body.timeoutMs,
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        stream: true,
      });
      return;
    }

    let out: any;
    try {
      out = await invokeModelChatUpstreamStream({
        app,
        subject: req.ctx.subject!,
        body: {
          purpose: body.purpose,
          modelRef: body.modelRef,
          constraints: body.constraints,
          scene: body.scene,
          outputSchema: body.outputSchema,
          messages: body.messages,
          timeoutMs: body.timeoutMs,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
        },
        locale: req.ctx.locale ?? "zh-CN",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        onDelta: () => {
        },
      });
    } catch (err: any) {
      if (err && typeof err === "object" && (err as any).audit) {
        const a = (err as any).audit;
        if (a?.errorCategory) req.ctx.audit!.errorCategory = String(a.errorCategory);
        if (a?.outputDigest) req.ctx.audit!.outputDigest = a.outputDigest;
      }
      const details = err && typeof err === "object" && "details" in err ? (err as any).details : undefined;
      if (err?.errorCode === "OUTPUT_SCHEMA_VALIDATION_FAILED") {
        return reply.status(422).send({
          errorCode: "OUTPUT_SCHEMA_VALIDATION_FAILED",
          message: { "zh-CN": "模型输出不满足 outputSchema", "en-US": "Model output does not satisfy outputSchema" },
          details: details ?? null,
          traceId: req.ctx.traceId,
        });
      }
      throw err;
    }

    req.ctx.audit!.inputDigest = { purpose: body.purpose, scene: out.scene, modelRef: body.modelRef ?? null, messageCount: body.messages.length, structuredOutputRequested: Boolean(body.outputSchema) };
    req.ctx.audit!.outputDigest = {
      routingDecision: out.routingDecision,
      usage:
        out.usage && typeof out.usage === "object"
          ? { promptTokens: (out.usage as any).prompt_tokens ?? null, completionTokens: (out.usage as any).completion_tokens ?? null, totalTokens: (out.usage as any).total_tokens ?? null }
          : { tokens: null },
      latencyMs: out.latencyMs ?? null,
      outputTextLen: typeof out.outputText === "string" ? out.outputText.length : null,
      attempts: out.attempts ?? null,
      safetySummary: out.safetySummary ?? null,
    };

    return {
      outputText: out.outputText,
      output: out.output ?? null,
      routingDecision: out.routingDecision,
      usage: out.usage ?? { tokens: null },
      latencyMs: out.latencyMs ?? null,
      traceId: req.ctx.traceId,
    };
  });

  app.post("/models/chat/stream", async (req, reply) => {
    setAuditContext(req, { resourceType: "model", action: "invoke.stream" });
    const decision = await requirePermission({ req, resourceType: "model", action: "invoke" });
    req.ctx.audit!.policyDecision = decision;
    const body = bodySchema.parse(req.body);
    await handleChatStream(req, reply, {
      purpose: body.purpose,
      modelRef: body.modelRef,
      constraints: body.constraints,
      scene: body.scene,
      outputSchema: body.outputSchema,
      messages: body.messages,
      timeoutMs: body.timeoutMs,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      stream: true,
    });
  });
};
