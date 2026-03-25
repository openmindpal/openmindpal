import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import GovSyncConflictsClient from "./ui";

async function loadTickets(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/sync/conflict-tickets?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovSyncConflictsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadTickets(locale);
  return (
    <GovSyncConflictsClient locale={locale} initial={initial.json} initialStatus={initial.status} />
  );
}

