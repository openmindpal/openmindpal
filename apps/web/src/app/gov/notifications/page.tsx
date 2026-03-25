import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovNotificationsClient from "./ui";

export default async function GovNotificationsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <GovNotificationsClient locale={locale} />;
}

