import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import QuotasClient from "./ui";
import { cookies } from "next/headers";

async function loadLimits(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/model-gateway/limits`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadToolLimits(locale: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/governance/tool-limits?limit=200`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function GovQuotasPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const [limitsRes, toolLimitsRes] = await Promise.all([loadLimits(locale), loadToolLimits(locale)]);
  return (
    <ConsoleShell locale={locale}>
      <QuotasClient locale={locale} initialLimits={limitsRes.json} initialLimitsStatus={limitsRes.status} initialToolLimits={toolLimitsRes.json} initialToolLimitsStatus={toolLimitsRes.status} />
    </ConsoleShell>
  );
}
