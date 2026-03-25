import { apiFetch, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovWorkbenchDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadInitial(locale: string, workbenchKey: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const [detailRes, effRes] = await Promise.all([
    apiFetch(`/workbenches/${encodeURIComponent(workbenchKey)}`, { token, locale, cache: "no-store" }),
    apiFetch(`/workbenches/${encodeURIComponent(workbenchKey)}/effective`, { token, locale, cache: "no-store" }),
  ]);
  const detailJson: unknown = await detailRes.json().catch(() => null);
  const effJson: unknown = await effRes.json().catch(() => null);
  return { detail: { status: detailRes.status, json: detailJson }, effective: { status: effRes.status, json: effJson } };
}

export default async function GovWorkbenchDetailPage(props: { params: Promise<{ workbenchKey: string }>; searchParams: Promise<SearchParams> }) {
  const params = await Promise.resolve(props.params);
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const initial = await loadInitial(locale, params.workbenchKey);
  return <GovWorkbenchDetailClient locale={locale} workbenchKey={params.workbenchKey} initial={initial} />;
}

