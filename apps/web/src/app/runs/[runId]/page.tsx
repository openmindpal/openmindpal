import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import RunClient from "./ui";
import { cookies } from "next/headers";

async function loadRun(locale: string, runId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/runs/${encodeURIComponent(runId)}`, { method: "GET", token, locale, cache: "no-store", signal: AbortSignal.timeout(SSR_TIMEOUT_MS) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function RunPage(props: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const runId = decodeURIComponent(params.runId);
  const runRes = await loadRun(locale, runId);

  return (
    <RunClient locale={locale} runId={runId} initial={runRes.json} initialStatus={runRes.status} />
  );
}
