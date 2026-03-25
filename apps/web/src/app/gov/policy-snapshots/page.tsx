import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { cookies } from "next/headers";
import GovPolicySnapshotsClient from "./ui.tsx";

async function loadPage(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/policy/snapshots?limit=50`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovPolicySnapshotsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadPage(locale);
  return (
    <GovPolicySnapshotsClient locale={locale} initial={initial.json} initialStatus={initial.status} />
  );
}
