import { Errors } from "../../../lib/errors";

export type OpenAiChatMessage = { role: string; content: string };

export async function openAiChatWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  chatCompletionsPath: string;
  model: string;
  messages: OpenAiChatMessage[];
  apiKeys: string[];
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: any = null;
  const baseUrl = String(params.baseUrl ?? "").replace(/\/+$/g, "");
  const chatPathRaw = String(params.chatCompletionsPath ?? "").trim() || "/chat/completions";
  const chatPath = chatPathRaw.startsWith("/") ? chatPathRaw : `/${chatPathRaw}`;
  const url = `${baseUrl}${chatPath}`;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
    try {
      const res = await params.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
          ...(typeof params.maxTokens === "number" ? { max_tokens: params.maxTokens } : {}),
        }),
        signal: ctrl.signal,
      });

      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        const err = Errors.modelUpstreamFailed(`status=${res.status}`);
        (err as any).upstreamStatus = res.status;
        throw err;
      }

      const content = json?.choices?.[0]?.message?.content;
      const outputText = typeof content === "string" ? content : content != null ? String(content) : "";
      const usage = json?.usage && typeof json.usage === "object" ? json.usage : { tokens: null };
      return { outputText, usage, secretTries: i + 1 };
    } catch (e: any) {
      const isAbort = String(e?.name ?? "") === "AbortError";
      if (isAbort) {
        lastErr = Errors.modelUpstreamFailed("timeout");
        (lastErr as any).upstreamTimeout = true;
      } else {
        lastErr = e;
      }
      const retryable = Boolean(
        lastErr &&
          typeof lastErr === "object" &&
          "errorCode" in lastErr &&
          (lastErr as any).errorCode === "MODEL_UPSTREAM_FAILED" &&
          (((lastErr as any).upstreamStatus ?? null) === 429 || Boolean((lastErr as any).upstreamTimeout)),
      );
      if (retryable && i < apiKeys.length - 1) continue;
      throw lastErr;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? Errors.modelUpstreamFailed("unknown");
}

function coerceAbortError(e: any) {
  const name = String(e?.name ?? "");
  const msg = String(e?.message ?? "");
  return name === "AbortError" || msg.includes("AbortError");
}

function parseSseBlocks(buffer: string) {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

function extractDataLines(block: string) {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trimStart());
  }
  return out;
}

export async function openAiChatStreamWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  chatCompletionsPath: string;
  model: string;
  messages: OpenAiChatMessage[];
  apiKeys: string[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onUsage?: (usage: any) => void;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: any = null;
  const baseUrl = String(params.baseUrl ?? "").replace(/\/+$/g, "");
  const chatPathRaw = String(params.chatCompletionsPath ?? "").trim() || "/chat/completions";
  const chatPath = chatPathRaw.startsWith("/") ? chatPathRaw : `/${chatPathRaw}`;
  const url = `${baseUrl}${chatPath}`;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const abortByOuter = () => ctrl.abort();
    if (params.signal) {
      if (params.signal.aborted) ctrl.abort();
      else params.signal.addEventListener("abort", abortByOuter, { once: true });
    }

    let sawAnyDelta = false;
    try {
      const res = await params.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: params.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
          ...(typeof params.maxTokens === "number" ? { max_tokens: params.maxTokens } : {}),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = Errors.modelUpstreamFailed(`status=${res.status}`);
        (err as any).upstreamStatus = res.status;
        throw err;
      }
      if (!res.body || typeof (res.body as any).getReader !== "function") {
        const err = Errors.modelUpstreamFailed("missing_body");
        (err as any).upstreamStatus = 502;
        throw err;
      }

      const reader = (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;
        for (const block of parsed.blocks) {
          const lines = extractDataLines(block);
          for (const data of lines) {
            if (!data) continue;
            if (data === "[DONE]") return { secretTries: i + 1 };
            let json: any = null;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            const usage = json?.usage;
            if (usage && typeof usage === "object" && params.onUsage) params.onUsage(usage);
            const delta = json?.choices?.[0]?.delta;
            const content = delta?.content;
            if (typeof content === "string" && content.length) {
              sawAnyDelta = true;
              params.onDelta(content);
            }
          }
        }
      }
      return { secretTries: i + 1 };
    } catch (e: any) {
      const isAbort = coerceAbortError(e);
      if (isAbort) {
        lastErr = Errors.modelUpstreamFailed("用户取消请求");
      } else {
        lastErr = e;
      }
      const retryable = Boolean(
        !sawAnyDelta &&
          lastErr &&
          typeof lastErr === "object" &&
          "errorCode" in lastErr &&
          (lastErr as any).errorCode === "MODEL_UPSTREAM_FAILED" &&
          (((lastErr as any).upstreamStatus ?? null) === 429),
      );
      if (retryable && i < apiKeys.length - 1) continue;
      throw lastErr;
    } finally {
      if (params.signal) params.signal.removeEventListener("abort", abortByOuter as any);
    }
  }
  throw lastErr ?? Errors.modelUpstreamFailed("unknown");
}
