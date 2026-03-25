export type ModelCatalogEntry = {
  provider: string;
  model: string;
  modelRef: string;
  endpointHost: string;
  capabilities: Record<string, unknown>;
  defaultLimits: { timeoutMs: number };
};

export const modelCatalog: ModelCatalogEntry[] = [];

export const openaiCompatibleProviders = ["openai_compatible", "deepseek", "hunyuan", "qianwen", "zhipu", "doubao", "kimi", "kimimax"] as const;
export type OpenAiCompatibleProvider = (typeof openaiCompatibleProviders)[number];

function isOpenAiCompatibleProvider(v: string): v is OpenAiCompatibleProvider {
  return (openaiCompatibleProviders as readonly string[]).includes(v);
}

export function findCatalogByRef(modelRef: string) {
  const exact = modelCatalog.find((e) => e.modelRef === modelRef) ?? null;
  if (exact) return exact;

  const m = /^([a-z0-9_]+):(.+)$/.exec(String(modelRef ?? "").trim());
  if (!m) return null;
  const provider = m[1];
  const model = m[2];
  if (!provider || !model) return null;
  if (!isOpenAiCompatibleProvider(provider)) return null;
  return {
    provider,
    model,
    modelRef: `${provider}:${model}`,
    endpointHost: "",
    capabilities: { chat: true, structuredOutput: false },
    defaultLimits: { timeoutMs: 20000 },
  };
}
