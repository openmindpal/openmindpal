import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import GovDevicesClient from "./ui";

export default async function GovDevicesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  return <GovDevicesClient locale={locale} />;
}

