import { Errors } from "../../lib/errors";

export type OpenAiChatMessage = { role: string; content: string };

export async function openAiChatWithSecretRotation(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  model: string;
  messages: OpenAiChatMessage[];
  apiKeys: string[];
  timeoutMs: number;
}) {
  const apiKeys = params.apiKeys.map((k) => String(k)).filter(Boolean);
  if (!apiKeys.length) throw Errors.badRequest("缺少 apiKey");

  let lastErr: any = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i]!;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.timeoutMs);
    try {
      const res = await params.fetchFn(`${params.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
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

