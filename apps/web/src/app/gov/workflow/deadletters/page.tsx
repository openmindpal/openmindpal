import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import DeadlettersClient from "./ui.tsx";

async function loadDeadletters(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/workflow/deadletters?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovWorkflowDeadlettersPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const deadlettersRes = await loadDeadletters(locale);
  return (
    <DeadlettersClient locale={locale} initial={deadlettersRes.json} initialStatus={deadlettersRes.status} />
  );
}
