import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import RoutingClient from "./ui";
import { cookies } from "next/headers";

async function loadPolicies(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/model-gateway/routing?limit=200`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovRoutingPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const listRes = await loadPolicies(locale);
  return (
    <ConsoleShell locale={locale}>
      <RoutingClient locale={locale} initial={listRes.json} initialStatus={listRes.status} />
    </ConsoleShell>
  );
}
