import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovWorkbenchesClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/workbenches`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { items: { status: res.status, json } };
}

export default async function GovWorkbenchesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale);
  return <GovWorkbenchesClient locale={locale} initial={initial} />;
}

