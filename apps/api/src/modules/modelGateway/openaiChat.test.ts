import { describe, expect, it } from "vitest";
import { openAiChatWithSecretRotation } from "./openaiChat";

function okResponse(payload: any) {
  return { ok: true, status: 200, json: async () => payload } as any;
}

function errResponse(status: number, payload: any = {}) {
  return { ok: false, status, json: async () => payload } as any;
}

describe("openAiChatWithSecretRotation", () => {
  it("rotates on 429", async () => {
    const calls: any[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      calls.push(init?.headers?.authorization ?? "");
      if (calls.length === 1) return errResponse(429);
      return okResponse({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 2 } });
    }) as any;

    const out = await openAiChatWithSecretRotation({
      fetchFn,
      baseUrl: "http://example",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      apiKeys: ["k1", "k2"],
      timeoutMs: 100,
    });
    expect(out.outputText).toBe("ok");
    expect(out.secretTries).toBe(2);
    expect(calls[0]).toContain("k1");
    expect(calls[1]).toContain("k2");
  });

  it("rotates on timeout", async () => {
    const calls: any[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      calls.push(init?.headers?.authorization ?? "");
      if (calls.length === 1) {
        return await new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (sig && typeof sig.addEventListener === "function") {
            sig.addEventListener("abort", () => {
              const e: any = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }
        });
      }
      return okResponse({ choices: [{ message: { content: "ok2" } }], usage: { total_tokens: 3 } });
    }) as any;

    const out = await openAiChatWithSecretRotation({
      fetchFn,
      baseUrl: "http://example",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      apiKeys: ["k1", "k2"],
      timeoutMs: 1,
    });
    expect(out.outputText).toBe("ok2");
    expect(out.secretTries).toBe(2);
    expect(calls[0]).toContain("k1");
    expect(calls[1]).toContain("k2");
  });

  it("does not rotate on non-retryable upstream status", async () => {
    const calls: any[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      calls.push(init?.headers?.authorization ?? "");
      return errResponse(400);
    }) as any;

    await expect(
      openAiChatWithSecretRotation({
        fetchFn,
        baseUrl: "http://example",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        apiKeys: ["k1", "k2"],
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ errorCode: "MODEL_UPSTREAM_FAILED" });
    expect(calls.length).toBe(1);
  });
});

