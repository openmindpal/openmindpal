import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import SafetyPoliciesClient from "./ui";

async function loadPolicies(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/safety-policies?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovSafetyPoliciesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadPolicies(locale);
  return (
    <SafetyPoliciesClient locale={locale} initial={initial.json} initialStatus={initial.status} />
  );
}

