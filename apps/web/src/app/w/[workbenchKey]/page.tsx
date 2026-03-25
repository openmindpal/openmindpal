import { apiFetch, pickLocale, SSR_TIMEOUT_MS } from "@/lib/api";
import { cookies } from "next/headers";
import type { SearchParams } from "@/lib/types";
import WorkbenchHostClient from "./ui";

async function loadEffective(locale: string, workbenchKey: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await apiFetch(`/workbenches/${encodeURIComponent(workbenchKey)}/effective`, {
    method: "GET",
    token,
    locale,
    cache: "no-store",
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function WorkbenchPage(props: { params: Promise<{ workbenchKey: string }>; searchParams: Promise<SearchParams> }) {
  const params = await props.params;
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const effective = await loadEffective(locale, params.workbenchKey);
  return (
    <WorkbenchHostClient locale={locale} workbenchKey={params.workbenchKey} initial={effective.json} initialStatus={effective.status} />
  );
}
