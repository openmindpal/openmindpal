import { resolveLocale } from "@openslin/shared";

function parseAcceptLanguage(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const first = headerValue.split(",")[0]?.trim();
  if (!first) return undefined;
  const tag = first.split(";")[0]?.trim();
  return tag || undefined;
}

export function resolveRequestLocale(params: {
  userLocale?: string;
  spaceLocale?: string;
  tenantLocale?: string;
  acceptLanguage?: string;
  platformLocale?: string;
}): string {
  return resolveLocale({
    userLocale: params.userLocale ?? parseAcceptLanguage(params.acceptLanguage),
    spaceLocale: params.spaceLocale,
    tenantLocale: params.tenantLocale,
    platformLocale: params.platformLocale,
  });
}
