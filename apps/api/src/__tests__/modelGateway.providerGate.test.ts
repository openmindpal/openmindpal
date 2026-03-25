import { describe, expect, it } from "vitest";
import { isSupportedModelProvider, openaiCompatibleProviders, supportedModelProviders } from "../skills/model-gateway/modules/catalog";

describe("model gateway provider gate", () => {
  it("includes core providers", () => {
    expect(supportedModelProviders).toContain("openai");
    expect(supportedModelProviders).toContain("mock");
  });

  it("includes all openai-compatible providers", () => {
    for (const p of openaiCompatibleProviders) {
      expect(isSupportedModelProvider(p)).toBe(true);
    }
  });

  it("rejects unknown providers", () => {
    expect(isSupportedModelProvider("anthropic")).toBe(false);
    expect(isSupportedModelProvider("gemini")).toBe(false);
    expect(isSupportedModelProvider("")).toBe(false);
  });
});
