/**
 * 公共 LLM 调用工具函数。
 * 任何 skill 均可直接 import 使用，无需依赖编排器。
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors";

export type LlmSubject = { tenantId: string; spaceId?: string; subjectId: string };

function base64UrlEncode(buf: Buffer) {
  return buf.toString("base64url");
}

/**
 * 为内部 skill 间调用生成认证 header。
 * 支持 dev / hmac / pat 三种模式（由环境变量 AUTHN_MODE 决定）。
 */
export function makeInternalAuthHeader(subject: LlmSubject): string {
  const mode =
    process.env.AUTHN_MODE === "pat"
      ? "pat"
      : process.env.AUTHN_MODE === "hmac"
        ? "hmac"
        : "dev";
  if (mode === "dev") {
    const space = subject.spaceId ?? "space_dev";
    return `Bearer ${subject.subjectId}@${space}`;
  }
  if (mode === "hmac") {
    const secret = String(process.env.AUTHN_HMAC_SECRET ?? "");
    if (!secret) return "";
    const exp = Math.floor(Date.now() / 1000) + 5 * 60;
    const payload = { tenantId: subject.tenantId, subjectId: subject.subjectId, spaceId: subject.spaceId ?? null, exp };
    const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest();
    const sigPart = base64UrlEncode(sig);
    return `Bearer ${payloadPart}.${sigPart}`;
  }
  return "";
}

/**
 * 调用模型网关 /models/chat，返回模型输出。
 * 这是最底层的 LLM 调用函数，各 skill 按需组合 prompt 后直接调用。
 */
export async function invokeModelChat(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization?: string | null;
  traceId?: string | null;
  purpose: string;
  messages: { role: string; content: string }[];
  timeoutMs?: number;
  headers?: Record<string, string>;
}): Promise<{ outputText: string; [key: string]: unknown }> {
  const auth = (params.authorization ?? "").trim() || makeInternalAuthHeader(params.subject);
  if (!auth) throw new AppError({ errorCode: "AUTH_UNAUTHORIZED", httpStatus: 401, message: { "zh-CN": "未认证", "en-US": "Unauthorized" } });

  const res = await params.app.inject({
    method: "POST",
    url: "/models/chat",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      "x-user-locale": params.locale,
      ...(params.traceId ? { "x-trace-id": params.traceId } : {}),
      ...(params.headers ?? {}),
    },
    payload: { purpose: params.purpose, messages: params.messages, timeoutMs: params.timeoutMs },
  });
  const body = res.body ? JSON.parse(res.body) : null;
  if (res.statusCode >= 200 && res.statusCode < 300) return body as any;
  const errorCode = typeof body?.errorCode === "string" ? body.errorCode : "MODEL_CHAT_FAILED";
  const message =
    body?.message && typeof body.message === "object"
      ? body.message
      : { "zh-CN": String(body?.message ?? "模型调用失败"), "en-US": String(body?.message ?? "Model invocation failed") };
  const appErr = new AppError({ errorCode, httpStatus: res.statusCode || 500, message });
  if (appErr.httpStatus === 429) {
    const retryAfterHeader = (res.headers as any)?.["retry-after"];
    const retryAfterSec = Number(body?.retryAfterSec ?? retryAfterHeader);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) (appErr as any).retryAfterSec = retryAfterSec;
  }
  throw appErr;
}

/**
 * 解析模型输出中的 tool_call 块。
 * 约定格式：```tool_call\n[{"toolRef":"...","inputDraft":{...}}]\n```
 * 返回清理后的文本和解析出的工具调用列表。
 */
export function parseToolCallsFromOutput(text: string): {
  cleanText: string;
  toolCalls: Array<{ toolRef: string; inputDraft: Record<string, unknown> }>;
  parseErrorCount: number;
} {
  const toolCalls: Array<{ toolRef: string; inputDraft: Record<string, unknown> }> = [];
  let parseErrorCount = 0;
  const regex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (typeof item?.toolRef === "string" && item.toolRef.trim()) {
          toolCalls.push({
            toolRef: item.toolRef.trim(),
            inputDraft:
              item.inputDraft && typeof item.inputDraft === "object" && !Array.isArray(item.inputDraft)
                ? item.inputDraft
                : {},
          });
        }
      }
    } catch {
      parseErrorCount += 1;
    }
  }
  const cleanText = text.replace(/\n?```tool_call\s*\n[\s\S]*?```\n?/g, "").trim();
  return { cleanText, toolCalls, parseErrorCount };
}
