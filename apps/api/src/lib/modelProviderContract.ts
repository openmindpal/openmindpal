/**
 * Model Provider Contract — kernel-level type + validation.
 *
 * This module lives in lib/ so that core governance code can check whether a
 * provider string is supported WITHOUT importing from the model-gateway Skill.
 * The model-gateway Skill's catalog.ts re-exports these for backward compat.
 */

export const openaiCompatibleProviders = [
  "openai_compatible",
  "deepseek",
  "hunyuan",
  "qianwen",
  "zhipu",
  "doubao",
  "kimi",
  "kimimax",
] as const;

export type OpenAiCompatibleProvider = (typeof openaiCompatibleProviders)[number];

export function isOpenAiCompatibleProvider(v: string): v is OpenAiCompatibleProvider {
  return (openaiCompatibleProviders as readonly string[]).includes(v);
}

export const supportedModelProviders = ["openai", "mock", ...openaiCompatibleProviders] as const;
export type SupportedModelProvider = (typeof supportedModelProviders)[number];

export function isSupportedModelProvider(v: string): v is SupportedModelProvider {
  return v === "openai" || v === "mock" || isOpenAiCompatibleProvider(v);
}
