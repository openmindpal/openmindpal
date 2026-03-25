import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ChangeSetsClient from "./ui";
import { cookies } from "next/headers";

async function loadChangeSets(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/changesets?limit=20`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadPipelines(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/governance/changesets/pipelines?limit=20&mode=full`, { token, locale, cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovChangeSetsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const [listRes, pipeRes] = await Promise.all([loadChangeSets(locale), loadPipelines(locale)]);
  return (
    <ChangeSetsClient locale={locale} initial={listRes.json} initialStatus={listRes.status} initialPipelines={pipeRes.json} initialPipelinesStatus={pipeRes.status} />
  );
}
