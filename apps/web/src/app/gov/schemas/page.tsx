import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import SchemasClient from "./ui";

async function loadSchemas(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/schemas`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovSchemasPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadSchemas(locale);
  return (
    <SchemasClient locale={locale} initial={initial.json} initialStatus={initial.status} />
  );
}

