import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovArtifactPolicyClient from "./ui";
import { cookies } from "next/headers";

async function loadPolicy(locale: string, scopeType: "space" | "tenant") {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  q.set("scopeType", scopeType);
  const res = await apiFetch(`/governance/artifact-policy?${q.toString()}`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovArtifactPolicyPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initialScopeType = (searchParams.scopeType === "tenant" ? "tenant" : "space") as "space" | "tenant";
  const initialRes = await loadPolicy(locale, initialScopeType);
  return (
    <GovArtifactPolicyClient locale={locale} initial={initialRes.json} initialStatus={initialRes.status} initialScopeType={initialScopeType} />
  );
}
