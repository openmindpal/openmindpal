import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovUiPagesClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/ui/pages`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { pages: { status: res.status, json } };
}

export default async function GovUiPagesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale);
  return <GovUiPagesClient locale={locale} initial={initial} />;
}

