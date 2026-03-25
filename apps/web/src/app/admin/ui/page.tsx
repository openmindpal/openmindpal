import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import AdminUiClient from "./ui";
import type { SearchParams } from "@/lib/types";

export default async function AdminUiPage(props: { searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const headers = apiHeaders(locale);
  const pagesRes = await fetch(`${API_BASE}/ui/pages`, { headers, cache: "no-store" });
  const pages = pagesRes.ok ? await pagesRes.json() : null;
  return (
    <ConsoleShell locale={locale}>
      <AdminUiClient locale={locale} initialPages={pages} />
    </ConsoleShell>
  );
}
