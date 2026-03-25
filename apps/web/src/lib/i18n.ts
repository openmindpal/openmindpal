import enUS from "../locales/en-US.json";
import zhCN from "../locales/zh-CN.json";

export type WebLocale = "zh-CN" | "en-US";

const dicts: Record<WebLocale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function normalizeLocale(locale: string | undefined): WebLocale {
  if (locale === "en-US") return "en-US";
  return "zh-CN";
}

export function t(locale: string | undefined, key: string) {
  const l = normalizeLocale(locale);
  return dicts[l][key] ?? dicts["en-US"][key] ?? dicts["zh-CN"][key] ?? key;
}

