import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovUiPageDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string, name: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/ui/pages/${encodeURIComponent(name)}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { page: { status: res.status, json } };
}

export default async function GovUiPageDetailPage(props: { params: Promise<{ name: string }>; searchParams: Promise<SearchParams> }) {
  const params = await Promise.resolve(props.params);
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale, params.name);
  return <GovUiPageDetailClient locale={locale} name={params.name} initial={initial} />;
}

