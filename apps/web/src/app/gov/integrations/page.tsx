import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import IntegrationsClient from "./ui";

export default async function GovIntegrationsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <IntegrationsClient locale={locale} />;
}

