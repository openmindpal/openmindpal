import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import RunsClient from "./ui";
import { cookies } from "next/headers";

function pickFirst(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function loadRuns(locale: string, searchParams: SearchParams) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const q = new URLSearchParams();
  const status = pickFirst(searchParams.status);
  const updatedFrom = pickFirst(searchParams.updatedFrom);
  const updatedTo = pickFirst(searchParams.updatedTo);
  const limit = pickFirst(searchParams.limit);
  if (status) q.set("status", status);
  if (updatedFrom) q.set("updatedFrom", updatedFrom);
  if (updatedTo) q.set("updatedTo", updatedTo);
  if (limit) q.set("limit", limit);
  const res = await apiFetch(`/runs?${q.toString()}`, { token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json, initialQuery: { status, updatedFrom, updatedTo, limit } };
}

export default async function RunsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const runsRes = await loadRuns(locale, searchParams);
  return (
    <RunsClient locale={locale} initial={runsRes.json} initialStatus={runsRes.status} initialQuery={runsRes.initialQuery} />
  );
}
