import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import AuditClient from "./ui";

export default async function GovAuditPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <AuditClient locale={locale} />;
}
